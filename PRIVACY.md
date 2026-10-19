# Lumen Recorder for Chrome: privacy policy

*Last updated: 14 October 2026*

Lumen Recorder is a screen recorder extension. It has no accounts, no analytics and no
Lumen servers. The developer does not receive, collect or store any of your data.

## What stays on your computer

- **Recordings.** The tab, window or screen you choose, your mic and your camera, only
  while you record. They're saved as video files in Chrome's storage for the extension,
  on your computer, until you download or delete them.
- **Settings.** Your mic, camera and sound choices, the bubble's look, and voice samples
  you record in "Fine-tune by ear" (the last one per mic, so you can come back to it).
- **The face bubble and noise removal** run inside the extension, on your computer
  (MediaPipe and RNNoise, bundled in the package).

## What leaves your computer, and where it goes

Only if you connect a share site, and only to **your own Cloudflare account**:

- **When you share a recording:** the video, its title, a poster image and preview
  frames are uploaded to your share site (a Cloudflare Worker, R2 storage and D1
  database in your account).
- **Transcript, title, summary, chapters and um-cutting** (on by default when sharing,
  can be switched off on the Share links page): your mic's sound is sent to your share
  site, which uses Cloudflare Workers AI in your account to transcribe it and write the
  title, summary and chapters.
- **Setting up a share site** from the extension uses a Cloudflare API token you create;
  the extension uses it once to create the share site in your account and then forgets
  it. Chrome asks for permission to reach api.cloudflare.com only at that step.
- **Connecting** stores your share site's address and a key just for this browser in
  Chrome's local storage (never synced). Disconnecting removes the key from your site too.

Cloudflare's own terms and privacy policy apply to your Cloudflare account. Anyone with a
share link can watch that video unless you set a password; you can delete videos and
revoke browser keys from your share site's dashboard at any time.

## Permissions

Lumen acts only on the tab you start it from, after you click its button or press its
shortcut. See the store listing for what each permission is for.

## Contact

Questions or problems: https://github.com/fasi96/lumen-chrome/issues
