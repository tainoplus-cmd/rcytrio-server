# RCYTrio Server

WebSocket server for RCYTrio. It handles:

- **Online matchmaking** for 2, 3 or 4 players, with server-side game rules and turn control
- **Friend directory** so a player can be found by their 10-digit ID even when offline
- **LAN rooms** (host creates a room, friends join with the room list, moves are relayed)

## Files

| File | Purpose |
|---|---|
| `server.js` | The whole server |
| `package.json` | Dependencies (`ws`) and start script |
| `Dockerfile` | For hosts that build from a Dockerfile (e.g. Back4App Containers) |
| `.dockerignore` | Keeps `node_modules` and `dir.json` out of the image |

Upload all four files together, in the same folder (the repo root).

## Run locally

```bash
npm install
npm start
```

The server listens on `PORT` (default `8080`). Opening `http://localhost:8080` in a browser should show `RCYTrio server OK`.

To test locally, set the client address to `ws://localhost:8080`.

## Deploy (Back4App Containers)

1. Put the four files in a GitHub repo (at the root, not inside a subfolder).
2. In Back4App Containers, create a new app from that repo.
3. Wait for the build to finish. When the app is running, open its URL in a browser and check that it shows `RCYTrio server OK`.
4. Use the address as `wss://YOUR-APP-URL` in the game.

If you replace the old server, redeploy and make sure the old container is stopped or replaced, otherwise the game may keep talking to the old code.

## Connecting the game

In `RCYTrio_22.html`, the address appears in two places:

- `const RCY_ONLINE_DEFAULT='wss://...'`
- `<input type="hidden" id="online-server" value="wss://...">`

Change both if the server URL changes.

## Protocol summary

Client to server:

- `hello {name, av}` sets the player name and avatar
- `matchmake {players: 2|3|4}` joins the queue
- `cancel_matchmaking`
- `move {idx, size}` with `size` as `S`, `M` or `L`
- `chat {text}`, `reaction {index}`
- `leave_room`
- `dir_register {fid, name, av, cc}` and `dir_find {fid}`
- `lan_create`, `lan_list`, `lan_join`, `lan_kick`, `lan_leave`, `lan_relay`

Server to client:

- `queue`, `queue_cancelled`, `match`, `state`, `chat`, `reaction`, `opponent_left`, `left_room`, `error`
- `dir_ok`, `dir_found`, `dir_notfound`
- `lan_created`, `lan_joined`, `lan_members`, `lan_rooms`, `lan_closed`, `lan_kicked`, `lan_error`, `lan_data`

## Game rules enforced by the server

- Each player has 3 small, 3 medium and 3 large rings.
- A ring can only go on a cell where that size is still free.
- A player wins with three of the same size in a line, an ascending or descending S-M-L line, or S+M+L stacked in one cell.
- Players with no legal move are skipped. If nobody can move, the game is a draw.
- If a player takes more than 65 seconds, the server plays a random legal move for them.

## Notes

- The friend directory is saved to `dir.json`. On free hosting the disk is often wiped on restart, so players are re-registered the next time they open the game. For a permanent directory, connect a database.
- Dead connections are removed every 20 seconds so nobody sits in the matchmaking queue as a ghost.
- Room and queue data lives in memory only. Restarting the server ends running matches.

## Troubleshooting

**Stuck on "Finding players"**
- Check the server URL in a browser. It should show `RCYTrio server OK`.
- Make sure both players picked the same mode (2, 3 or 4 players).
- Make sure the deployed code is the new `server.js`.

**Friend ID search finds nobody**
- The friend must have opened the game at least once after the new server started, so they get registered.
- Check that the ID has exactly 10 digits.
