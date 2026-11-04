import SwiftUI
import WebKit
import ARKit

/// A web view on the HandCam page plus an ARKit session that calls window.handcamPose([x,y,z],[qx,qy,qz,qw]) each frame.
/// ARKit and three.js agree on axes (right-handed, y up, camera looks down -z, metres), so the numbers pass straight through;
/// the page re-anchors heading and position itself.
struct ARWebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // lets the page know it's inside the app (it then hides the Android AR button)
        config.userContentController.add(context.coordinator, name: "handcam")
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.scrollView.isScrollEnabled = false
        context.coordinator.web = web
        web.load(URLRequest(url: url))
        context.coordinator.start()
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) { coordinator.session.pause() }

    final class Coordinator: NSObject, ARSessionDelegate, WKScriptMessageHandler {
        let session = ARSession()
        weak var web: WKWebView?
        private var last: TimeInterval = 0
        // ARKit's camera transform is relative to the sensor (landscape); the page is portrait: turn by 90° about z.
        private let portrait = simd_quatf(angle: .pi / 2, axis: SIMD3<Float>(0, 0, 1))

        func start() {
            guard ARWorldTrackingConfiguration.isSupported else { return }
            let config = ARWorldTrackingConfiguration()
            config.worldAlignment = .gravity // y up; heading is re-anchored by the page
            session.delegate = self
            session.run(config)
        }

        func session(_ session: ARSession, didUpdate frame: ARFrame) {
            guard frame.timestamp - last > 1.0 / 61.0, let web else { return } // ≤ 60 Hz, like the gyro path
            last = frame.timestamp
            let t = frame.camera.transform
            let q = simd_quatf(t) * portrait
            let js = String(format: "window.handcamPose&&window.handcamPose([%.4f,%.4f,%.4f],[%.6f,%.6f,%.6f,%.6f],'arkit')",
                            t.columns.3.x, t.columns.3.y, t.columns.3.z, q.imag.x, q.imag.y, q.imag.z, q.real)
            web.evaluateJavaScript(js, completionHandler: nil)
        }

        func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {}
    }
}
