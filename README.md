# LookAtMyQuant Launcher

A modern macOS desktop companion for `lookatmyquant` that lets you browse models, estimate memory fit, and run a local OpenAI/Anthropic-compatible inference server without touching the terminal.

Repository: [github.com/Shreyas-Dasari/LookAtMyQuant-Gui](https://github.com/Shreyas-Dasari/LookAtMyQuant-Gui)

## Features

- **One-Click Server Control**: Start and stop your local inference server from the Status page and monitor uptime, thermal state, and live dependency updates.
- **Visual Model Manager**: Browse local models and speculative drafters in a clean dual-column view.
- **Smart RAM Estimator**: Color-coded fit indicators (green/yellow/red) compare estimated model memory against your Mac's total RAM.
- **Built-in Model Downloader**: Browse and download quantized models from `shinmegamiboson` on Hugging Face directly inside the app.
- **Live System & Log Monitoring**: Track system RAM, Apple Silicon hardware readout, thermal state, and real-time server logs, plus one-click copy for OpenAI and Anthropic API endpoints.
- **Automatic First-Run Setup**: If the local Python MLX runtime isn't installed yet, the app displays a guided **Install Dependencies** overlay with live progress before unlocking.

## Credits

This project is a graphical launcher built on top of:

- **[lookatmyquant](https://github.com/ShinMegamiBoson/lookatmyquant)** by ShinMegamiBoson — Quantization compiler, packed model formats, and Apple Silicon MLX runtime.
- **[mlx-lm](https://github.com/ml-explore/mlx-lm)** & **[mlx](https://github.com/ml-explore/mlx)** — Apple Silicon ML framework and LLM inference foundation.

---

## Install via Homebrew (Cask)

Once a GitHub Release `.dmg` is published, users can install from the tap:

```bash
brew tap Shreyas-Dasari/lookatmyquant-gui https://github.com/Shreyas-Dasari/LookAtMyQuant-Gui
brew install --cask lookatmyquant-gui
```

The cask installs `uv` as a dependency and places `LookAtMyQuant Launcher.app` into `/Applications`. On first launch, click **Install Dependencies** in the setup overlay to automatically create the Python 3.12 MLX environment.

### Publishing a Release for Homebrew

1. Update `version` in `Casks/lookatmyquant-gui.rb` (and `lookatmyquant-tauri/src-tauri/tauri.conf.json`).
2. Build the `.app` and `.dmg` and automatically update the cask SHA256:
   ```bash
   ./scripts/package-release.sh
   ```
3. Create a GitHub Release (`v0.1.0`, etc.) on `Shreyas-Dasari/LookAtMyQuant-Gui` and upload the `.dmg` from `lookatmyquant-tauri/src-tauri/target/release/bundle/dmg/`.

---

## Running from Source (Development)

### Prerequisites

- macOS 11+ on Apple Silicon (arm64)
- Rust (latest stable)
- Node.js 20+ and npm
- `uv` (`brew install uv`) or Python 3.10+ (3.12 recommended)

### Start Dev Mode

```bash
cd lookatmyquant-tauri
npm install
npm run tauri dev
```

If `.venv` does not exist yet, the app will prompt you to click **Install Dependencies** on launch and set up `.venv` automatically.

### Building the `.app` / `.dmg` Bundle

```bash
cd lookatmyquant-tauri
npm install
npm run tauri build
```

Built bundles are written to:
- `.app`: `lookatmyquant-tauri/src-tauri/target/release/bundle/macos/LookAtMyQuant Launcher.app`
- `.dmg`: `lookatmyquant-tauri/src-tauri/target/release/bundle/dmg/`

## License

Copyright © 2026 Shreyas Dasari. Released under the [MIT License](LICENSE).
