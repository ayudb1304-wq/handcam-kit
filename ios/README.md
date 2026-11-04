# HandCam AR for iPhone (Phase 6, optional)

Safari has no AR tracking, so on iPhone the browser can only turn (gyro) and walk with the stick. This tiny app shows
the same HandCam phone page and adds ARKit tracking: **walk 5 m with the phone and the camera moves 5 m** (×3 or ×10
with the speed button). Everything else is the web page, unchanged.

## Build it (Xcode 15+ and an iPhone with iOS 17+)

1. Xcode → File → New → Project → iOS → **App**. Name `HandCamAR`, Interface **SwiftUI**, Language **Swift**.
2. Delete the generated `ContentView.swift` and `HandCamARApp.swift`; drag in the two `.swift` files from `ios/HandCamAR/`.
3. Target → Info: add the keys from `Info-additions.plist` (camera usage text, `arkit` capability).
4. Target → Signing & Capabilities: pick your Apple ID team.
5. Plug in the iPhone, choose it as the run destination, press ▶. (ARKit doesn't run in the Simulator.)
6. In the app, paste the HandCam link (`https://….trycloudflare.com/cam` from `npm run share`, or the desk's QR link) and tap Open.
   Tap **Enable motion**, then **Re‑anchor**: from then on your steps move the camera. "Walk: steps/stick" on the top bar switches it off and on.

Takes record `device.source = "arkit+joystick"`. Android phones with ARCore get the same through Chrome's WebXR: the
**Walk** button appears on the phone page by itself where it's supported.
