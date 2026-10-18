import ARKit
import SwiftUI
import RoomPlan
import UIKit
import ImageIO

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
    // Defaults can be baked in at build time (TADAIMA_SERVER / TADAIMA_UPLOAD_KEY build settings).
    @AppStorage("tadaimaServer") private var server = Bundle.main.object(forInfoDictionaryKey: "TadaimaServer") as? String ?? ""
    @AppStorage("tadaimaUploadKey") private var uploadKey = Bundle.main.object(forInfoDictionaryKey: "TadaimaUploadKey") as? String ?? ""
    @State private var sending = false
    @State private var uploadStatus: String?

    var body: some View {
        NavigationStack {
            GeometryReader { layout in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("A room scan. No tape measure.").font(.title2.weight(.semibold))
                        Text("Move slowly. Include walls, floors and furniture from several angles. Pause briefly to save clear appearance photos.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        if let view = model.detailView {
                            NativeDetailView(view: view).id(model.scanID)
                                .frame(height: max(240, layout.size.height * 0.44))
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                        } else if let view = model.captureView {
                            NativeRoomView(view: view).id(model.scanID)
                                .frame(height: max(240, layout.size.height * 0.44))
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                        } else if !model.supported {
                            ContentUnavailableView("LiDAR iPhone required", systemImage: "viewfinder",
                                description: Text("Use an iPhone 14 Pro or another RoomPlan-supported LiDAR device. The simulator cannot scan a room."))
                        } else {
                            ContentUnavailableView("Ready to scan", systemImage: "viewfinder",
                                description: Text("RoomPlan uses the camera and LiDAR. Photos and scans stay local until you share them."))
                        }
                        if model.phase == .idle || model.phase == .failed {
                            Toggle("Capture real surface geometry", isOn: $model.recordDetailedSurfaces)
                                .onChange(of: model.recordDetailedSurfaces) { _, enabled in
                                    if enabled { model.recordAppearancePhotos = true }
                                }
                            Text("After the room layout, walk around furniture for a detailed LiDAR pass. Captures observed surfaces rather than furniture boxes.")
                                .font(.caption).foregroundStyle(.secondary)
                            Toggle("Save appearance photos", isOn: $model.recordAppearancePhotos)
                                .disabled(model.recordDetailedSurfaces)
                            Text("Automatically saves up to 32 photos with camera positions. Detailed surfaces require photos for appearance; no automatic upload.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if model.phase == .detailing {
                            Text("\(model.meshFaceCount) surface triangles observed")
                                .font(.subheadline).accessibilityAddTraits(.updatesFrequently)
                        }
                        if model.phase == .detailing || (model.phase == .scanning && !model.recordDetailedSurfaces), model.recordAppearancePhotos {
                            HStack {
                                Text("\(model.photoCount)/32 photos saved").font(.subheadline)
                                Spacer()
                                Button("Capture photo") { model.capturePhoto() }.buttonStyle(.bordered)
                            }
                            if let detail = model.photoMessage {
                                Text(detail).font(.caption).foregroundStyle(.secondary)
                                    .accessibilityAddTraits(.updatesFrequently)
                            }
                        }
                        if model.phase == .review || model.phase == .exporting {
                            if let scanName = model.scanName {
                                Text(scanName).font(.headline).textSelection(.enabled)
                            }
                            TextField("Room name", text: $model.roomLabel)
                                .textFieldStyle(.roundedBorder).disabled(model.isBusy)
                                .accessibilityLabel("Room name")
                            Text(model.mesh != nil
                                ? "\(model.surfaceCount) layout surfaces, \(model.objectCount) object detections, \(model.meshFaceCount) captured triangles and \(model.photoCount) photos. The detailed bundle contains observed room and furniture surfaces for automatic photo texturing."
                                : "\(model.surfaceCount) surfaces, \(model.objectCount) objects and \(model.photoCount) photos. RoomPlan furniture shapes are size proxies. No detailed surface mesh was saved.")
                                .font(.footnote).foregroundStyle(.secondary)
                            if !model.photos.isEmpty {
                                ScrollView(.horizontal) {
                                    LazyHStack(spacing: 8) {
                                        ForEach(model.photos, id: \.metadata.id) { photo in
                                            if let image = photoThumbnail(photo.jpeg) {
                                                Image(uiImage: image).resizable().scaledToFill()
                                                    .frame(width: 88, height: 66).clipped()
                                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                                    .accessibilityLabel("Captured room appearance photo")
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if let warning = model.captureWarning {
                            Text(warning).font(.footnote).foregroundStyle(.orange)
                                .accessibilityAddTraits(.updatesFrequently)
                        }
                        if let message = model.message {
                            Text(message).font(.footnote).foregroundStyle(.orange)
                                .accessibilityAddTraits(.updatesFrequently)
                        }
                        if model.isBusy {
                            HStack { ProgressView(); Text(progressMessage).font(.subheadline) }
                        }
                        controls
                        Text("Send to Tadaima uploads the scan and photos to the Tadaima scan server, which rebuilds the room for shopping. Share scan + photos keeps geometry, JPEGs and camera calibration together. Nothing uploads until you tap Send.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .padding()
                }
            }
            .navigationTitle("tadaima / scan")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $share) { item in ScanShareSheet(url: item.url) }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { share = nil; model.backgrounded() }
            }
            // Auto-lock backgrounds the app, which discards an in-progress scan or upload.
            .onChange(of: model.phase) { _, _ in updateIdleTimer() }
            .onChange(of: sending) { _, _ in updateIdleTimer() }
        }
    }

    private func updateIdleTimer() {
        let active: [ScanModel.Phase] = [.requestingPermission, .scanning, .processing, .detailing, .finishingDetail, .exporting]
        UIApplication.shared.isIdleTimerDisabled = sending || active.contains(model.phase)
    }

    private func send() async {
        sending = true
        defer { sending = false }
        do {
            let uploader = try ScanUploader(server: server, key: uploadKey)
            uploadStatus = "Preparing the scan…"
            guard let file = await model.shareFile(includeUSDZ: false, includePhotos: model.photoExportKind != nil) else {
                uploadStatus = nil  // The model reports export problems in its own message.
                return
            }
            uploadStatus = "Sending to Tadaima…"
            var status = try await uploader.upload(file)
            uploadStatus = "Building your room…"
            var polls = 0
            while ["queued", "running"].contains(status.status) && polls < 300 {
                try await Task.sleep(for: .seconds(2))
                status = try await uploader.status(status.id)
                polls += 1
            }
            if status.ready {
                uploadStatus = "Ready. On the laptop, open Tadaima › Your rooms and choose Enter room."
            } else if status.status == "failed" {
                uploadStatus = (status.error ?? "The room could not be rebuilt.") + " Scan again."
            } else {
                uploadStatus = "Still building after 10 minutes. Check Tadaima on the laptop."
            }
        } catch {
            uploadStatus = error.localizedDescription
        }
    }

    private func photoThumbnail(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData,
            [kCGImageSourceShouldCache: false] as CFDictionary),
              let pixels = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 264,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else { return nil }
        // This app captures in portrait; rotate only the display copy. Exported
        // sensor pixels and calibration remain unchanged for reconstruction.
        return UIImage(cgImage: pixels, scale: 1, orientation: .right)
    }

    private var progressMessage: String {
        switch model.phase {
        case .requestingPermission: "Waiting for camera permission…"
        case .processing: "Processing the room layout…"
        case .finishingDetail: "Saving detailed surfaces…"
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
                Button(model.recordDetailedSurfaces ? "Continue to real surfaces" : "Finish & review") { Task { await model.finish() } }.buttonStyle(.borderedProminent)
                Button("Cancel scan", role: .cancel) { model.rescan() }.buttonStyle(.bordered)
            }
        case .detailing:
            HStack {
                Button("Finish surfaces & review") { Task { await model.finishDetail() } }
                    .buttonStyle(.borderedProminent)
                Button("Cancel scan", role: .cancel) { model.rescan() }.buttonStyle(.bordered)
            }
        case .requestingPermission, .processing, .finishingDetail:
            Button("Cancel scan", role: .cancel) { model.rescan() }.buttonStyle(.bordered)
        case .review:
            VStack(alignment: .leading, spacing: 10) {
                TextField("Scan server, e.g. https://your-service.up.railway.app", text: $server)
                    .textFieldStyle(.roundedBorder).keyboardType(.URL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(sending)
                TextField("Upload key", text: $uploadKey)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(sending)
                Button(sending ? "Sending…" : "Send to Tadaima") { Task { await send() } }
                    .buttonStyle(.borderedProminent).disabled(sending)
                if let uploadStatus {
                    Text(uploadStatus).font(.footnote).accessibilityAddTraits(.updatesFrequently)
                }
                if let exportKind = model.photoExportKind {
                    Button(exportKind.label) {
                        Task {
                            if let url = await model.shareFile(includeUSDZ: false, includePhotos: true) {
                                share = SharedScan(url: url)
                            }
                        }
                    }.buttonStyle(.bordered).disabled(sending)
                }
                HStack {
                    Button("Share scan JSON") { Task { if let url = await model.shareFile(includeUSDZ: false) { share = SharedScan(url: url) } } }
                        .buttonStyle(.bordered)
                    Button("Share USDZ") { Task { if let url = await model.shareFile(includeUSDZ: true) { share = SharedScan(url: url) } } }
                        .buttonStyle(.bordered)
                }
                Button("Scan again") { share = nil; uploadStatus = nil; model.rescan() }.buttonStyle(.bordered).disabled(sending)
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
    // Session lifecycle belongs to ScanModel, including the shared-session detail pass.
}

private struct NativeDetailView: UIViewRepresentable {
    let view: ARSCNView
    func makeUIView(context: Context) -> ARSCNView { view }
    func updateUIView(_ uiView: ARSCNView, context: Context) {}
    // Replacing a view must not pause the shared session.
}

private struct ScanShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
