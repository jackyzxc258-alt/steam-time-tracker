/**
 * Standalone collector — runs in GitHub Actions, bypasses Vercel entirely.
 */
const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: WebSocket },
});

async function getConfig() {
  const { data, error } = await supabase.from("child_config").select("*").eq("id", 1).single();
  if (error) throw new Error(`Config read error: ${error.message}`);
  if (!data) throw new Error("No child_config row found.");
  return data;
}

async function resolveSteamId(apiKey, input) {
  if (/^\d{17}$/.test(String(input))) return String(input);
  const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${input}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.response?.success === 1) return json.response.steamid;
  throw new Error(`Cannot resolve Steam ID: ${JSON.stringify(json)}`);
}

async function fetchOwnedGames(apiKey, steamId) {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true`;
  const res = await fetch(url);
  const json = await res.json();
  return json.response?.games || [];
}

async function main() {
  console.log("[collect] Starting...");
  const config = await getConfig();
  const steamId = await resolveSteamId(config.steam_api_key, config.steam_id || config.steam_vanity_url);
  console.log(`[collect] Steam ID: ${steamId}`);

  const games = await fetchOwnedGames(config.steam_api_key, steamId);
  console.log(`[collect] Fetched ${games.length} games`);

  // Upsert games
  const gameRows = games.map(g => ({
    appid: g.appid,
    name: g.name || `App ${g.appid}`,
    icon_url: g.img_icon_url ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg` : null,
    updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < gameRows.length; i += 50) {
    const { error } = await supabase.from("games").upsert(gameRows.slice(i, i + 50), { onConflict: "appid" });
    if (error) console.error("upsertGames error:", error.message);
  }

  // Insert snapshots
  const now = new Date().toISOString();
  const snapRows = games.map(g => ({ appid: g.appid, total_minutes: g.playtime_forever, recorded_at: now }));
  const { error: snapErr } = await supabase.from("play_snapshots").insert(snapRows);
  if (snapErr) console.error("insertSnapshots error:", snapErr.message);

  // Compute daily summary
  const { error: rpcErr } = await supabase.rpc("compute_daily_summary");
  if (rpcErr) console.error("RPC error:", rpcErr.message);
  else console.log("[collect] Daily summary updated");

  console.log("[collect] Done.");
}

main().catch(err => { console.error("[collect] FATAL:", err.message); process.exit(1); });
