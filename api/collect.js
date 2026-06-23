/**
 * Steam Game Time Collector — Vercel Serverless Function
 *
 * Triggered by Vercel Cron every 30 minutes.
 * 1. Reads Steam API key + Steam ID from Supabase child_config
 * 2. Calls Steam GetOwnedGames API
 * 3. Inserts play_snapshots
 * 4. Computes daily_summary (delta from first snapshot of the day)
 */

const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

// ── Supabase client (uses env vars set in Vercel dashboard) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service_role for server-side writes
);

// ── Helpers ──

/** Fetch child config from Supabase */
async function getConfig() {
  const { data, error } = await supabase
    .from("child_config")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`Config read error: ${error.message}`);
  if (!data) throw new Error("No child_config row found. Run setup first.");
  return data;
}

/** Resolve Steam numeric ID from vanity URL if needed */
async function resolveSteamId(apiKey, input) {
  // If it's already a numeric 64-bit ID, use directly
  if (/^\d{17}$/.test(String(input))) return String(input);

  // Otherwise treat as vanity URL slug
  const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${input}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.response?.success === 1) return json.response.steamid;
  throw new Error(`Cannot resolve Steam ID for "${input}": ${JSON.stringify(json)}`);
}

/** Fetch owned games from Steam API */
async function fetchOwnedGames(apiKey, steamId) {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json.response?.games) {
    console.log("No games returned from Steam API");
    return [];
  }
  return json.response.games;
}

/** Upsert game dictionary */
async function upsertGames(games) {
  const rows = games.map((g) => ({
    appid: g.appid,
    name: g.name || `App ${g.appid}`,
    icon_url: g.img_icon_url
      ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
      : null,
    updated_at: new Date().toISOString(),
  }));

  // upsert in chunks (Supabase upsert needs primary key)
  const chunkSize = 50;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from("games").upsert(chunk, { onConflict: "appid" });
    if (error) console.error("upsertGames error:", error.message);
  }
}

/** Insert play snapshots */
async function insertSnapshots(games) {
  const now = new Date().toISOString();
  const rows = games.map((g) => ({
    appid: g.appid,
    total_minutes: g.playtime_forever,
    recorded_at: now,
  }));

  const { error } = await supabase.from("play_snapshots").insert(rows);
  if (error) console.error("insertSnapshots error:", error.message);
}

/** Recompute today's daily_summary */
async function recomputeDailySummary() {
  // PostgreSQL function: for each game, daily = max(total) - min(total) today
  const { error } = await supabase.rpc("compute_daily_summary");
  if (error) {
    console.error("compute_daily_summary RPC error:", error.message);
    // Fallback: do it in JS
    await computeDailySummaryJS();
  }
}

/** JS fallback: compute today's daily summary */
async function computeDailySummaryJS() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Get today's snapshots
  const { data, error } = await supabase
    .from("play_snapshots")
    .select("appid, total_minutes")
    .gte("recorded_at", `${today}T00:00:00Z`)
    .lte("recorded_at", `${today}T23:59:59Z`)
    .order("recorded_at", { ascending: true });

  if (error || !data?.length) return;

  // Group by appid → { min, max, count }
  const groups = {};
  for (const row of data) {
    if (!groups[row.appid]) {
      groups[row.appid] = { min: row.total_minutes, max: row.total_minutes, count: 0 };
    }
    groups[row.appid].min = Math.min(groups[row.appid].min, row.total_minutes);
    groups[row.appid].max = Math.max(groups[row.appid].max, row.total_minutes);
    groups[row.appid].count++;
  }

  // Build upsert rows
  const rows = [];
  for (const [appid, g] of Object.entries(groups)) {
    rows.push({
      date: today,
      appid: parseInt(appid),
      game_name: "?",
      minutes_today: g.max - g.min,
      snapshot_count: g.count,
    });
  }

  // Fill game names
  for (const row of rows) {
    const { data: g } = await supabase
      .from("games")
      .select("name")
      .eq("appid", row.appid)
      .single();
    if (g) row.game_name = g.name;
  }

  const { error: upsertErr } = await supabase
    .from("daily_summary")
    .upsert(rows, { onConflict: "date, appid" });
  if (upsertErr) console.error("daily_summary upsert error:", upsertErr.message);
}

// ── Main handler ──

module.exports = async (req, res) => {
  try {
    console.log("[collect] Starting collection...");

    // 1. Get config
    const config = await getConfig();
    const steamId = await resolveSteamId(config.steam_api_key, config.steam_id || config.steam_vanity_url);
    console.log(`[collect] Steam ID: ${steamId}`);

    // 2. Fetch games from Steam
    const games = await fetchOwnedGames(config.steam_api_key, steamId);
    console.log(`[collect] Fetched ${games.length} games`);

    // 3. Upsert game dictionary
    await upsertGames(games);

    // 4. Insert snapshots
    await insertSnapshots(games);
    console.log("[collect] Snapshots inserted");

    // 5. Recompute daily summary
    await recomputeDailySummary();
    console.log("[collect] Daily summary updated");

    return res.status(200).json({
      success: true,
      games_tracked: games.length,
      games_with_playtime: games.filter((g) => g.playtime_forever > 0).length,
    });
  } catch (err) {
    console.error("[collect] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
