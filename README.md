# LookAtMyQuant Launcher

A modern macOS desktop companion for `lookatmyquant` to manage local models, check RAM fit, and run an OpenAI/Anthropic-compatible inference server without touching the terminal.

## Install via Homebrew

```bash
brew tap Shreyas-Dasari/lookatmyquant-gui
brew install --cask --no-quarantine lookatmyquant-gui
```

Requires macOS 11+ on Apple Silicon. Homebrew installs `uv` automatically; on first launch, click **Install Dependencies** in the setup overlay to create your local Python MLX environment.

## Features

- **One-Click Server Control**: Start and stop the local inference server, monitor uptime, and track dependency updates for `lookatmyquant` and MLX.
- **Visual Model Manager**: Browse local models and speculative drafters in a clean dual-column view.
- **Smart RAM Estimator**: Color-coded fit indicators (green/yellow/red) compare estimated model memory against your Mac's total RAM.
- **Built-in Model Downloader**: Browse and download quantized models from `shinmegamiboson` on Hugging Face directly inside the app.
- **Live System & Log Monitoring**: View hardware readout, RAM usage, thermal state, real-time server logs, and copy OpenAI / Anthropic endpoints with one click.
- **Automatic First-Run Setup**: Guided dependency installer sets up `mlx`, `mlx-lm`, `huggingface-hub`, and `lookatmyquant` on first launch.

## Credits

- **[lookatmyquant](https://github.com/ShinMegamiBoson/lookatmyquant)** by ShinMegamiBoson — Quantization compiler, packed model formats, and Apple Silicon MLX runtime.
- **[mlx-lm](https://github.com/ml-explore/mlx-lm)** & **[mlx](https://github.com/ml-explore/mlx)** — Apple Silicon ML framework and LLM inference foundation.

---

## Running from Source

### Prerequisites

- macOS 11+ on Apple Silicon (`arm64`)
- Rust (latest stable)
- Node.js 20+ and npm
- `uv` (`brew install uv`) or Python 3.10+ (`3.12` recommended)

### Development Mode

```bash
cd lookatmyquant-tauri
npm install
npm run tauri dev
```

### Build `.app` / `.dmg`

```bash
cd lookatmyquant-tauri
npm install
npm run tauri build
```

Built bundles are written to:
- `.app`: `lookatmyquant-tauri/src-tauri/target/release/bundle/macos/LookAtMyQuant Launcher.app`
- `.dmg`: `lookatmyquant-tauri/src-tauri/target/release/bundle/dmg/`

Or run `./scripts/package-release.sh` to build the `.dmg` and update the cask SHA256 automatically.

## License

Copyright © 2026 Shreyas Dasari. Released under the [MIT License](LICENSE).
