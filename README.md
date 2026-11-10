# Minecraft by DH: Bedrock Edition

A browser voxel sandbox written in TypeScript. It runs on Three.js with a Node.js signaling server. Friends join with a six-digit session code and play over direct WebRTC, with a WebSocket relay fallback.

## Features

- **Multiplayer sessions:** host or join with a 6-digit code. Roles are member, operator, visitor and banned, with host moderation (kick, ban, unban, role changes). Reconnects resume the same seat for 60 seconds using a session-token HMAC handshake.
- **Worlds:** deterministic terrain for the Overworld, Nether and End. 3D noise biomes include Plains, Badlands, Mangrove Swamps and Deep Dark. Overworld↔Nether portals scale X/Z by 8.
- **Blocks:** waterlogging, directional stairs and slabs, fence connections.
- **Player:** Bedrock-style AABB controller with swimming, crawling, elytra gliding and waterlogging.
- **Redstone:** dust with 16-level signal decay, repeaters (delay cycling), levers, buttons, pistons (sticky and regular), slime and honey, redstone lamps, powered doors. Redstone runs on the host; joiners see dust levels through block state.
- **Mobs and villagers:** component-based mobs (wander, attack, flee, breed, pathfinding). Villagers have professions, levels, atomic trades and demand bonuses. The Warden appears in the Deep Dark.
- **Survival:** armour with durability and armour-point reduction, off-hand slot, shaped and shapeless recipes, difficulty rules, hunger and starvation.
- **Content packs:** JSON behaviour packs add blocks, items, entities, recipes and trades. Broken files are reported and skipped. The bundled sample is `public/packs/dh_sample/pack.json`.
- **Controls:** desktop pointer lock and keyboard. Touch joystick and look pad on phones.

## Layout

```
client/engine   Renderer, mesher, raycast, input, game state, app loop
client/net      Signaling session client, WebRTC mesh with relay fallback
client/ui       DOM overlay: menu, HUD, chat, roster, panels, touch controls
server/signaling  RoomManager (sessions, roles, bans, handshake) and HTTP/WebSocket server
shared/         Pure logic shared by client and server: protocols, world, redstone,
                physics, packs, crafting, survival, economy, AI
tests/unit      Vitest: redstone, portals, physics, AABB, recipes, villagers, survival,
                session handshake, game state, packs, mesher and raycast
tests/integration  Vitest against a real signaling server on an ephemeral port
e2e             Playwright multi-client tests (host and joiner in separate browsers)
```

## Commands

```bash
npm install
npm run dev          # Vite dev server on :5173 (proxies /ws to the signaling server)
npm run build        # typecheck + build client to dist/ and server to dist-server/
npm start            # production server: serves dist/, signaling on /ws, health on /healthz
npm run typecheck
npm test             # unit + integration
npm run test:e2e     # Playwright (uses the built server; set CHROMIUM_EXECUTABLE to reuse a Chromium)
```

Environment variables for the server: `PORT` (default 8080), `HOST` (default 0.0.0.0).

## Known gaps

- Comparators are not implemented.
- Brewing and enchanting exist only as block identifiers. There is no brewing or enchanting logic yet.
- Dropped items and death drops are not implemented. Respawn keeps the inventory.
- The client builds its own spawn from the shared seed. Spawn positions can differ if a host edits the spawn area before a joiner connects.

## Design notes

- **Authority:** the host owns the world, redstone and mobs. Clients predict their own edits and send them as `blockEdit`. The host validates them (role, reach, bounds) and rebroadcasts `blockUpdate`.
- **Transport:** game traffic uses one WebRTC data channel per client. If the channel does not open within 10 seconds, or ICE fails, traffic goes through the signaling relay. The server enforces per-role rules on every relayed payload.
- **Security:** rate limit of 120 messages per second per connection. Payloads are validated on both ends. Static serving rejects path traversal.
- **WebRTC:** the client uses the native `RTCPeerConnection`. `simple-peer` is not used.
