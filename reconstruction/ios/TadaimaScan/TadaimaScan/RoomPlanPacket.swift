import Foundation
import simd

/// Data-only interchange. World transforms retain native ARKit meters/Y-up.
struct RoomPlanPacket: Codable, Sendable {
    let schemaVersion: String
    let projectId: String
    let jobId: String
    let inputRevision: Int
    let capturedAt: String
    let roomId: String
    let roomLabel: String
    let device: ScanDevice
    let surfaces: [ScanSurface]
}

struct ScanDevice: Codable, Sendable {
    let model: String
    let systemVersion: String
}

struct ScanSurface: Codable, Sendable {
    let id: String
    let category: String
    let dimensions: [Float]
    let transform: [Float]
    let confidence: String
    let parentId: String?
    /// Local surface-plane coordinates, copied unchanged from RoomPlan.
    let polygonCorners: [[Float]]
    let isCurved: Bool

    enum CodingKeys: String, CodingKey {
        case id, category, dimensions, transform, confidence, parentId, polygonCorners, isCurved
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(category, forKey: .category)
        try values.encode(dimensions, forKey: .dimensions)
        try values.encode(transform, forKey: .transform)
        try values.encode(confidence, forKey: .confidence)
        if let parentId { try values.encode(parentId, forKey: .parentId) }
        else { try values.encodeNil(forKey: .parentId) }
        try values.encode(polygonCorners, forKey: .polygonCorners)
        try values.encode(isCurved, forKey: .isCurved)
    }
}

enum ScanWire {
    static func columnMajor(_ matrix: simd_float4x4) -> [Float] {
        (0..<4).flatMap { column in (0..<4).map { row in matrix[column][row] } }
    }

    static func vector(_ value: SIMD3<Float>) -> [Float] {
        [value.x, value.y, value.z]
    }

    static func encode(_ packet: RoomPlanPacket) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        // The default rejects NaN/infinity instead of writing invalid geometry.
        return try encoder.encode(packet)
    }
}

#if os(iOS) && canImport(RoomPlan)
import RoomPlan

extension ScanWire {
    static func surface(_ value: CapturedRoom.Surface, category: String) -> ScanSurface {
        let confidence: String
        switch value.confidence {
        case .low: confidence = "low"
        case .medium: confidence = "medium"
        case .high: confidence = "high"
        @unknown default: confidence = "unknown"
        }
        return ScanSurface(
            id: value.identifier.uuidString.lowercased(),
            category: category,
            dimensions: vector(value.dimensions),
            transform: columnMajor(value.transform),
            confidence: confidence,
            parentId: value.parentIdentifier?.uuidString.lowercased(),
            polygonCorners: value.polygonCorners.map(vector),
            isCurved: value.curve != nil
        )
    }

    static func packet(room: CapturedRoom, scanID: UUID, capturedAt: String,
                       label: String, device: ScanDevice) -> RoomPlanPacket {
        let surfaces = room.walls.map { surface($0, category: "wall") }
            + room.doors.map { surface($0, category: "door") }
            + room.windows.map { surface($0, category: "window") }
            + room.openings.map { surface($0, category: "opening") }
        return RoomPlanPacket(
            schemaVersion: "roomplan-scan/1.0", projectId: "local-roomplan",
            jobId: "scan-" + scanID.uuidString.lowercased(), inputRevision: 0,
            capturedAt: capturedAt, roomId: room.identifier.uuidString.lowercased(),
            roomLabel: label, device: device, surfaces: surfaces
        )
    }
}
#endif
