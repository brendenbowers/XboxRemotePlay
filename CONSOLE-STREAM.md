# Console Stream

Personal Windows Remote Play build based on Greenlight v2.4.2 (MIT). Upstream source and copyright are retained. It uses the existing Microsoft sign-in, console discovery, WebRTC video/audio and gamepad implementation, and adds direct game output to Discord.

## Run

Start `packages/desktop/dist/win-unpacked/Console Stream.exe` and sign in to the Microsoft account used by your Xbox. Then open **Settings → Streaming**: choose 1080p, 1440p or **4K / 2160p (experimental)** before starting a stream from **My Consoles**. Remote features must be enabled on the console.

The sign-in panel has a selectable pairing code, **Copy code**, **Open sign-in page** and a clickable Microsoft URL; the URL also works on another device. Sign-in continues automatically once Microsoft confirms it, and an expired attempt can be retried with a new code.

The app sends the selected dimensions in the session's device information. After the message handshake it also sends preferred dimensions plus the control-channel `userRequestedResolutionUpdate` alias. The 2160 alias is experimental: it requests native 4K but cannot force the console encoder to provide it.

The bottom-left overlay shows requested versus received dimensions, FPS and measured receive bitrate. **Save stream report** saves a small JSON snapshot without account credentials or console addresses. Startup can briefly use a lower resolution, so let the stream settle before saving a report.

Playback has no focus-loss pause or focus overlay. Electron background timer throttling and renderer backgrounding are disabled, so the gamepad driver polls independently of window focus. Keyboard input stays with the focused application.

This portable build stores its profile in `ConsoleStreamData` beside the executable, separately from the installed Xbox app and Greenlight. Account tokens are encrypted with Electron safeStorage (Windows account encryption). Keep the application in a writable folder; moving the profile to another Windows account requires signing in again.

**Settings → Video & Audio** offers a saved audio output device selector, including Windows Default. Routing failures fall back to the default output and show a warning, and device lists refresh when Windows reports a change. Default aspect preserves proportions; Stretch fills the window; Zoom crops to fill it.

## Keyboard, mouse and controller

Open **Settings → Input** or use the input panel during local/headless play. The saved **Input mode** switches between **Connected controller**, **Native keyboard & mouse (experimental)** and **Keyboard & mouse as controller** without restarting the stream. Connected controller mode uses the first standard-mapping PC controller and continues in the background.

For keyboard/mouse modes, click **Capture input** or press **F9** with the app focused. **Escape** or **F9** releases the pointer. Alt-Tab, session reconnect and mode switches clear held synthetic controls while video/audio continue. Headless mode has its own capture panel; it does not require a local video decoder. Capture does not include desktop audio or microphone input in Discord.

Emulation: **WASD = movement**, **mouse = aim**, **left click = RT/fire**, **right click = LT/aim**, **middle click = right-stick click**. Defaults include Space=A, Ctrl=B, R=X, F=Y, Q/E=shoulders, Shift=left-stick click, arrow keys=D-pad, Tab=View, Enter=Menu and N=Guide. Settings → Input offers button rebinding, mouse sensitivity, invert-Y and stick-deadzone compensation. Mouse input still obeys each game's controller deadzone/response curve and maximum turn speed; calibrate hip-fire and aiming in Cyberpunk 2077 and Starfield separately.

Native mode forwards virtual-key transitions, relative mouse movement, clicks and wheel. Console/game acceptance remains unverified; it does not add keyboard/mouse support to a game. Starfield's Xbox version requires controller emulation. Unicode/IME text injection is not implemented. Existing legacy input settings remain in the profile, but the new explicit selector controls the active input path.

## Discord output (experimental)

Discord output uses your normal Discord Canary session. Console Stream never reads an account token or Discord's profile, never captures your microphone and never stores stream credentials. Start Canary with local debugging on loopback (exit it from the tray first; a running instance ignores startup flags):

```powershell
& "$env:LOCALAPPDATA\DiscordCanary\app-<version>\DiscordCanary.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223
```

Join a server voice channel in Canary and stop any existing Discord share. The bridge's selectors are pinned to Canary 1.0.1256; on a changed client, unknown exports fail closed. This uses an unsupported client bridge, and Discord can restrict the account. Private calls are not supported.

Two ways to share:

- **Windowed:** in the stream window's **Discord output** panel, choose **Connect to Discord Canary**, then **Start game share**. If the console stream is not already using the Discord output profile (**Settings → Streaming**), the share first restarts the console stream with that profile, then starts automatically. Local play outside Discord keeps the normal streaming settings.
- **Headless:** **Headless Discord share** on a console card in **My Consoles**. The console stream is received directly by the publisher process, with no stream window or local picture. A PC controller connected to this computer is forwarded to the console, or play with the console's own controller.

In headless mode the console's bitrate starts from the profile bitrate and adapts through REMB toward the console. The console chooses its own resolution from that bandwidth without reconnecting (roughly 720p up to ~4 Mbps, 1080p from ~5 Mbps, 1440p from ~13 Mbps), never above the profile resolution. A clean high-resolution probe can retain a measured rate above an unchanged Discord estimate, as described below.

Both share panels show **Discord video sent** from the H.264 SPS of video accepted by the encrypted sender, separately from the **advertised maximum**. This measures our source passthrough, not the viewer's decoded size. The advertised ceiling grows if a windowed source ramps above its initial picture size. Headless mode also shows the actual Xbox bitrate, upstream target and Discord's estimate. A 9 Mbps estimate currently yields an 8.1 Mbps target and a 1080p Xbox picture; changing a resolution label cannot create a 1440p bitstream.

The Discord profile accepts an experimental 4K request and an initial rate up to 39 Mbps. Publisher/adaptation ceilings are 40 Mbps. 1440p was measured from the Xbox alone around 12.5–15 Mbps; 4K and higher-resolution viewer decoding remain unverified. Source frames are never upscaled.

Headless high-resolution sessions make one startup bandwidth probe after clean viewer delivery feedback and a positive bandwidth estimate: request 15 Mbps from Xbox for a 1440p profile (30 Mbps for experimental 4K), for up to 20 seconds. If the requested source size is reached and measured video exceeds the estimate with clean reports, the controller retains that quality rate and the panel explains it is holding the probed rate. A fresh report with ≥2% loss, an estimate falling more than 10% below the probe's starting estimate, or three seconds without new delivery reports ends probing/holding and restores normal adaptation. Ordinary adaptation does not increase the target without new reports. A fixed 9 Mbps estimate alone no longer forces a clean 1440p feed down to 1080p. There is no artificial padding or promise that Xbox will fill the requested rate; viewer decode still needs separate confirmation.

**Manual override:** in Settings → Streaming → Discord output profile, set the bitrate and enable **Override Discord's bitrate estimate (headless)**. This saves a fixed upstream Xbox bitrate request, without automatic probing or loss backoff. You can also switch override on/off from the console card during a headless stream; it applies the saved profile bitrate immediately. Turning it off restores automatic control. The live status identifies override mode. For a 1440p experiment choose roughly 15 Mbps and a 1440p resolution ceiling before starting. The console can still produce a lower size/rate; excessive bandwidth can buffer. The default remains automatic, and saved rate/resolution choices are not changed when the app is updated.

Video and audio are the console's own encoded H.264/Opus frames, without screen capture, virtual devices or re-encoding. Media is only sent after DAVE end-to-end encryption is negotiated, which happens when the first viewer joins; until then the panel shows **Waiting for viewer**. The stream thumbnail on the LIVE tile is uploaded through Canary's own client as soon as the share starts and refreshed every 5 minutes. Normal Discord talking and listening are unaffected.

The older separate-session credential route remains under **Legacy token connector**; Discord rejects it before stream creation.

## Build / check

Close Console Stream first. The build clears `dist`, so copy `dist/win-unpacked/ConsoleStreamData` somewhere safe and restore it beside the new executable afterwards. In `packages/desktop`:

```powershell
npm install --workspaces=false --legacy-peer-deps
# Install the isolated publisher dependencies once:
npm --prefix ../discord-proxy install --workspaces=false
npm run typecheck
npm run build -- --no-pack
npx electron-builder --win --x64 --dir --publish never
```

Tests:

```powershell
npm test
node tests/input-smoke.cjs
npm run test:desktop
npm run test:pairing
node tests/packaged-smoke.cjs
node tests/discord-output-smoke.cjs
node tests/saved-auth-smoke.cjs
npm --prefix ../discord-proxy test
npm --prefix ../discord-proxy run test:electron
```

The desktop smoke test mocks authentication only and exercises the real settings IPC, saved quality selection, background timers and Windows encryption. The packaged smoke test starts the actual executable and checks that it reaches sign-in. The publisher tests include real local DTLS/SRTP and data-channel connections against a stand-in console. None of them uses a live account or console.

The source uses the upstream `xbox-xcloud-player` 0.2.11 API without editing installed dependencies. Upstream update notifications are disabled so they don't replace these changes.
