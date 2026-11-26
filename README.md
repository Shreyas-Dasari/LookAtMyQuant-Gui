# LookAtMyQuant Launcher

A Mac desktop app for `shinmegamiboson` models. Pick a checkpoint, start a local server on port 8080, and point your tools at it.

## Install with Homebrew

```bash
brew tap Shreyas-Dasari/lookatmyquant-gui
brew install --cask --no-quarantine lookatmyquant-gui
```

The app bundle is unsigned. That is why `--no-quarantine` matters, since macOS Gatekeeper blocks unsigned downloads and calls them damaged. Homebrew installs `uv` for you automatically, and on first launch an overlay locks the window until you click **Install Dependencies** to pull Python 3.12, `mlx`, `mlx-lm`, `huggingface-hub`, and `lookatmyquant` into a local virtual environment.

## What the app does

Models and speculative drafters sit side by side in the Models tab. Each entry compares estimated memory against your Mac's total RAM with a green, yellow, or red dot, and the built-in downloader grabs new checkpoints straight from `shinmegamiboson` on Hugging Face. Live logs stream in the Server tab. You can also check for upstream `lookatmyquant` updates on the Status page, track chip RAM and thermal state, or copy local API URLs with one click.

## Credits

All inference runs on upstream code. [LookAtMyQuant](https://github.com/ShinMegamiBoson/lookatmyquant) by ShinMegamiBoson does the real work with its quantization compiler, packed formats, and Apple Silicon engine, backed by [mlx-lm](https://github.com/ml-explore/mlx-lm) and [mlx](https://github.com/ml-explore/mlx) on Metal.

## Build it yourself

You need an Apple Silicon Mac on macOS 11+, Rust, Node.js 20+, and `uv` or Python 3.10+. Start dev mode like this:

```bash
cd lookatmyquant-tauri
npm install
npm run tauri dev
```

Run `npm run tauri build` inside `lookatmyquant-tauri` to create a standalone `.app` and `.dmg`, or run `./scripts/package-release.sh` from the root. Files land in `lookatmyquant-tauri/src-tauri/target/release/bundle/macos/LookAtMyQuant Launcher.app` and `lookatmyquant-tauri/src-tauri/target/release/bundle/dmg/`. Moving a self-built app across Macs or installing it through a local cask still triggers macOS quarantine. Pass `--no-quarantine` to `brew`, or strip the flag directly with `xattr -cr "/Applications/LookAtMyQuant Launcher.app"`.

## License

Copyright 2026 Shreyas Dasari. MIT License, see [LICENSE](LICENSE).
