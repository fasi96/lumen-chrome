# Chrome Web Store listing: Lumen Recorder

Everything the developer dashboard asks for, field by field. Package: `npm run release`
→ `release/lumen-recorder-<version>.zip`.

## Store listing tab

**Name** (from the manifest): Lumen Recorder

**Summary** (manifest description, 132 max):
Loom-style recorder: your face in a bubble, ums cut, a share link on your own Cloudflare. The MP4 stays yours. Open source.

**Category:** Productivity → Communication

**Language:** English

**Description:**

Record a tab or your whole screen with your voice and your face in a bubble, then share it like a Loom: a link is on your clipboard the moment you stop.

No Lumen account and no Lumen server. Recordings are saved as MP4s on your computer. Share links are optional and live on your own Cloudflare account (free up to 10 GB of videos), so you own the link, the video and the stats.

WHAT YOU GET
• Record this tab in one click, or any screen or window
• Your face in a bubble that follows your outline (blob, circle or card), or float your camera over every app while you record your screen
• Sound presets for your mic (Natural, Podcast, Crisp, Noisy room), AI noise removal that runs on your computer, and "Fine-tune by ear" with your own voice sample
• A 3-2-1 countdown, and a keyboard shortcut to start and stop
• Every recording saved as an MP4 on this computer, with crash recovery

SHARE LINKS ON YOUR OWN CLOUDFLARE (optional)
• The link is copied the moment you stop; the video uploads in the background and resumes if Chrome closes
• A share page with the video, a clickable transcript, chapters, captions, hover previews and an optional password
• A title and summary written from what you said
• Ums and long pauses cut out of the shared copy (your own recording stays uncut)
• Set it up from the extension in a few minutes, or connect the share site you already have from Lumen on Omarchy

PRIVATE BY DESIGN
• Nothing leaves your computer unless you connect your own share site
• The face bubble and noise removal run inside the extension
• Open source (MIT): https://github.com/fasi96/lumen-chrome

**Icon:** `extension/icons/icon128.png`
**Screenshots (1280×800):** `docs/store/screenshots/1-bubble.png` … `4-sound.png`
**Small promo tile (440×280):** `docs/store/promo-440x280.png`
**Homepage URL:** https://github.com/fasi96/lumen-chrome
**Support URL:** https://github.com/fasi96/lumen-chrome/issues

## Privacy tab

**Single purpose:**
Record your browser tab or screen with your mic and camera, save it as an MP4, and optionally share it through your own Cloudflare account.

**Permission justifications:**
- `tabCapture`: records the tab you choose when you click Lumen's button or press its shortcut.
- `activeTab`: Lumen acts only on the tab you clicked it on: to record it, and to show the camera bubble, the 3-2-1 countdown and the "Show your camera" question on it.
- `scripting`: adds the camera bubble, countdown and question to that same tab (only after your click), and removes them when you stop.
- `offscreen`: the recorder runs in a hidden extension page, so recording keeps going when you switch tabs or close the popup.
- `storage`: saves your settings (mic, sound preset, bubble look) and, if you connect one, your share site's address and its key for this browser.
- `unlimitedStorage`: recordings are kept as video files on your computer until you download or delete them; they can be larger than the default quota.
- `clipboardWrite`: copies the share link to your clipboard when you stop.
- Optional host `https://api.cloudflare.com/*`: asked only if you choose "Set up my share site", to create the share site in your own Cloudflare account. Not requested otherwise.

**Remote code:** No. All code, including the WebAssembly for the face bubble (MediaPipe) and noise removal (RNNoise), is in the package. The setup wizard uploads Lumen's share-site code to *your* Cloudflare account; it never runs in the extension.

**Data usage — what is collected:** The developer collects nothing: no accounts, no analytics, no servers.
If you connect your own share site, these go to *your* Cloudflare account only, when you share:
- Website content: the recording of the tab or screen you chose, and its title
- Personal communications: your voice and camera in that recording; your mic's sound for the transcript, title and um-cutting (Cloudflare Workers AI in your account)

Certify: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used or transferred to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/fasi96/lumen-chrome/blob/main/PRIVACY.md

## Distribution tab
Public · all regions · free.
