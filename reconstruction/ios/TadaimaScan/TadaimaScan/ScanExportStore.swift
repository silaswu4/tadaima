import Foundation
import RoomPlan

/// Serialization and USDZ export run away from the main actor.
actor ScanExportStore {
    func export(room: CapturedRoom, packet: RoomPlanPacket, fileStem: String, includeUSDZ: Bool) throws -> URL {
        let manager = FileManager.default
        let documents = try manager.url(for: .documentDirectory, in: .userDomainMask,
                                        appropriateFor: nil, create: true)
        let root = documents.appendingPathComponent("Scans", isDirectory: true)
        let directory = root.appendingPathComponent(packet.jobId, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [
            .protectionKey: FileProtectionType.complete, .posixPermissions: 0o700
        ])
        var protectedDirectory = directory
        var attributes = URLResourceValues()
        attributes.isExcludedFromBackup = true
        try protectedDirectory.setResourceValues(attributes)
        let jsonURL = directory.appendingPathComponent(fileStem + ".json")
        try ScanWire.encode(packet).write(to: jsonURL, options: [.atomic, .completeFileProtection])
        try manager.setAttributes([.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600],
                                  ofItemAtPath: jsonURL.path)
        if !includeUSDZ { return jsonURL }
        let modelURL = directory.appendingPathComponent(fileStem + ".usdz")
        // Fresh filename for an explicit retry, never a stale export from another scan.
        if manager.fileExists(atPath: modelURL.path) { try manager.removeItem(at: modelURL) }
        do {
            try room.export(to: modelURL, exportOptions: .parametric)
            try manager.setAttributes([.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600],
                                      ofItemAtPath: modelURL.path)
            return modelURL
        } catch {
            try? manager.removeItem(at: modelURL)
            throw error
        }
    }

    func remove(scanID: UUID) {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let directory = documents.appendingPathComponent("Scans", isDirectory: true)
            .appendingPathComponent("scan-" + scanID.uuidString.lowercased(), isDirectory: true)
        try? FileManager.default.removeItem(at: directory)
    }
}
