import SwiftUI
import RoomPlan
import UIKit

@main
struct TadaimaScanApp: App {
    var body: some Scene { WindowGroup { ScanScreen() } }
}

private struct SharedScan: Identifiable {
    let id = UUID()
    let url: URL
}

struct ScanScreen: View {
    @StateObject private var model = ScanModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var share: SharedScan?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("A room scan. No tape measure.").font(.title2.weight(.semibold))
                Text("Move slowly and follow the on-screen RoomPlan guidance. Include existing furniture from several angles, then review the room.")
                    .font(.subheadline).foregroundStyle(.secondary)
                if let view = model.captureView {
                    NativeRoomView(view: view).id(model.scanID)
                        .frame(minHeight: 240, maxHeight: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                } else if !model.supported {
                    ContentUnavailableView("LiDAR iPhone required", systemImage: "viewfinder",
                        description: Text("Use an iPhone 14 Pro or another RoomPlan-supported LiDAR device. The simulator cannot scan a room."))
                } else {
                    ContentUnavailableView("Ready to scan", systemImage: "viewfinder",
                        description: Text("RoomPlan uses the camera and LiDAR. No photos or scans are uploaded by this app."))
                }
                if model.phase == .review || model.phase == .exporting {
                    if let scanName = model.scanName {
                        Text(scanName).font(.headline).textSelection(.enabled)
                    }
                    TextField("Room name", text: $model.roomLabel)
                        .textFieldStyle(.roundedBorder).disabled(model.isBusy)
                        .accessibilityLabel("Room name")
                    Text("\(model.surfaceCount) structural surfaces and \(model.objectCount) objects captured. Objects are detected size proxies, not textured copies. Review missing objects and sensor estimates.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let message = model.message {
                    Text(message).font(.footnote).foregroundStyle(.orange)
                        .accessibilityAddTraits(.updatesFrequently)
                }
                if model.isBusy {
                    HStack { ProgressView(); Text(progressMessage).font(.subheadline) }
                }
                controls
                Text("Local JSON is the Blender import bridge. USDZ is an optional native reference model. Sharing is your choice; there is no automatic upload.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding()
            .navigationTitle("tadaima / scan")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $share) { item in ScanShareSheet(url: item.url) }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { share = nil; model.backgrounded() }
            }
        }
    }

    private var progressMessage: String {
        switch model.phase {
        case .requestingPermission: "Waiting for camera permission…"
        case .processing: "Processing the room…"
        case .exporting: "Preparing the export…"
        default: "Please wait…"
        }
    }

    @ViewBuilder private var controls: some View {
        if model.cameraDenied {
            Button("Open camera settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
        }
        switch model.phase {
        case .idle, .failed:
            Button("Start room scan") { Task { await model.start() } }
                .buttonStyle(.borderedProminent).disabled(!model.supported)
        case .scanning:
            HStack {
                Button("Finish & review") { model.finish() }.buttonStyle(.borderedProminent)
                Button("Cancel scan", role: .cancel) { model.rescan() }.buttonStyle(.bordered)
            }
        case .requestingPermission, .processing:
            Button("Cancel scan", role: .cancel) { model.rescan() }.buttonStyle(.bordered)
        case .review:
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Button("Share scan JSON") { Task { if let url = await model.shareFile(includeUSDZ: false) { share = SharedScan(url: url) } } }
                        .buttonStyle(.borderedProminent)
                    Button("Share USDZ") { Task { if let url = await model.shareFile(includeUSDZ: true) { share = SharedScan(url: url) } } }
                        .buttonStyle(.bordered)
                }
                Button("Scan again") { share = nil; model.rescan() }.buttonStyle(.bordered)
            }
        case .exporting:
            EmptyView()
        }
    }
}

private struct NativeRoomView: UIViewRepresentable {
    let view: RoomCaptureView
    func makeUIView(context: Context) -> RoomCaptureView { view }
    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}
    static func dismantleUIView(_ uiView: RoomCaptureView, coordinator: ()) { uiView.captureSession.arSession.pause() }
}

private struct ScanShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
