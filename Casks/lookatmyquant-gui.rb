cask "lookatmyquant-gui" do
  version "0.1.0"
  sha256 "REPLACE_WITH_DMG_SHA256"

  url "https://github.com/Shreyas-Dasari/LookAtMyQuant-Gui/releases/download/v#{version}/LookAtMyQuant.Launcher_#{version}_aarch64.dmg"
  name "LookAtMyQuant Launcher"
  desc "Modern macOS launcher and local OpenAI/Anthropic server for LookAtMyQuant models"
  homepage "https://github.com/Shreyas-Dasari/LookAtMyQuant-Gui"

  depends_on arch: :arm64
  depends_on macos: ">= :big_sur"
  depends_on formula: "uv"

  app "LookAtMyQuant Launcher.app"

  zap trash: [
    "~/Library/Application Support/com.shreyas.lookatmyquant-launcher",
    "~/Library/Caches/com.shreyas.lookatmyquant-launcher",
    "~/Library/Preferences/com.shreyas.lookatmyquant-launcher.plist",
  ]
end
