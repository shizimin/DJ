import SwiftUI

@main
struct DJRigApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .task { model.start() }
                .persistentSystemOverlays(.hidden)
        }
        .onChange(of: scenePhase) { _, phase in
            // バックグラウンドでも鳴らし続ける（UIBackgroundModes = audio）。
            // 明示的に停止するのは終了時だけ。
            if phase == .background {
                model.library.scanMusicDirectory()
            }
        }
    }
}
