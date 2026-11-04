// HandCam AR (Phase 6, optional): a thin iPhone app that shows the normal HandCam phone page (/cam) in a web view and
// feeds it ARKit's real position and rotation, so walking with the phone moves the camera ("true walking").
// The page does everything else; this app only adds tracking. See ios/README.md.
import SwiftUI

@main
struct HandCamARApp: App {
    var body: some Scene {
        WindowGroup { ContentView().ignoresSafeArea() }
    }
}

struct ContentView: View {
    // The HandCam link: the https address `npm run share` prints, plus /cam (phone only) or the desk's QR link.
    @AppStorage("handcamURL") private var url = ""
    @State private var started = false

    var body: some View {
        if started, let u = URL(string: url) {
            ARWebView(url: u)
        } else {
            VStack(spacing: 16) {
                Text("HandCam AR").font(.largeTitle.bold())
                Text("Paste your HandCam link (…/cam). Walking with the phone will move the camera.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary)
                TextField("https://….trycloudflare.com/cam", text: $url)
                    .textFieldStyle(.roundedBorder).keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button("Open") { started = URL(string: url)?.scheme == "https" }
                    .buttonStyle(.borderedProminent).disabled(!url.hasPrefix("https://"))
            }
            .padding(28)
        }
    }
}
