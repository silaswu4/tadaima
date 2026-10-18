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
    let objects: [ScanObject]

    init(schemaVersion: String, projectId: String, jobId: String, inputRevision: Int,
         capturedAt: String, roomId: String, roomLabel: String, device: ScanDevice,
         surfaces: [ScanSurface], objects: [ScanObject] = []) {
        self.schemaVersion = schemaVersion; self.projectId = projectId; self.jobId = jobId
        self.inputRevision = inputRevision; self.capturedAt = capturedAt; self.roomId = roomId
        self.roomLabel = roomLabel; self.device = device; self.surfaces = surfaces; self.objects = objects
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion, projectId, jobId, inputRevision, capturedAt, roomId, roomLabel, device, surfaces, objects
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(String.self, forKey: .schemaVersion)
        projectId = try values.decode(String.self, forKey: .projectId)
        jobId = try values.decode(String.self, forKey: .jobId)
        inputRevision = try values.decode(Int.self, forKey: .inputRevision)
        capturedAt = try values.decode(String.self, forKey: .capturedAt)
        roomId = try values.decode(String.self, forKey: .roomId)
        roomLabel = try values.decode(String.self, forKey: .roomLabel)
        device = try values.decode(ScanDevice.self, forKey: .device)
        surfaces = try values.decode([ScanSurface].self, forKey: .surfaces)
        objects = schemaVersion == "roomplan-scan/1.0"
            ? try values.decodeIfPresent([ScanObject].self, forKey: .objects) ?? []
            : try values.decode([ScanObject].self, forKey: .objects)
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(schemaVersion, forKey: .schemaVersion)
        try values.encode(projectId, forKey: .projectId)
        try values.encode(jobId, forKey: .jobId)
        try values.encode(inputRevision, forKey: .inputRevision)
        try values.encode(capturedAt, forKey: .capturedAt)
        try values.encode(roomId, forKey: .roomId)
        try values.encode(roomLabel, forKey: .roomLabel)
        try values.encode(device, forKey: .device)
        try values.encode(surfaces, forKey: .surfaces)
        // Preserve the exact old wire shape for legacy fixtures. Never discard objects.
        if schemaVersion == "roomplan-scan/1.0" {
            guard objects.isEmpty else { throw ScanWireError.objectsRequireVersion11 }
        } else {
            try values.encode(objects, forKey: .objects)
        }
    }
}

/// Detected oriented size proxy, not an exact furniture mesh or catalog product.
struct ScanObject: Codable, Sendable {
    let id: String
    let category: String
    /// Native local width, height and depth in meters.
    let dimensions: [Float]
    /// Native object-center pose; elevated objects must not be snapped to the floor.
    let transform: [Float]
    let confidence: String
}

enum ScanWireError: Error {
    case tooManyObjects
    case objectsRequireVersion11
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
    static let maximumObjects = 256
    static func columnMajor(_ matrix: simd_float4x4) -> [Float] {
        (0..<4).flatMap { column in (0..<4).map { row in matrix[column][row] } }
    }

    static func vector(_ value: SIMD3<Float>) -> [Float] {
        [value.x, value.y, value.z]
    }

    static func encode(_ packet: RoomPlanPacket) throws -> Data {
        guard packet.objects.count <= maximumObjects else { throw ScanWireError.tooManyObjects }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        // The default rejects NaN/infinity instead of writing invalid geometry.
        return try encoder.encode(packet)
    }
}

#if os(iOS) && canImport(RoomPlan)
import RoomPlan

extension ScanWire {
    static func objectCategory(_ category: CapturedRoom.Object.Category) -> String {
        switch category {
        case .storage: "storage"
        case .refrigerator: "refrigerator"
        case .stove: "stove"
        case .bed: "bed"
        case .sink: "sink"
        case .washerDryer: "washerDryer"
        case .toilet: "toilet"
        case .bathtub: "bathtub"
        case .oven: "oven"
        case .dishwasher: "dishwasher"
        case .table: "table"
        case .sofa: "sofa"
        case .chair: "chair"
        case .fireplace: "fireplace"
        case .television: "television"
        case .stairs: "stairs"
        @unknown default: "unknown"
        }
    }

    static func object(_ value: CapturedRoom.Object) -> ScanObject {
        let confidence: String
        switch value.confidence {
        case .low: confidence = "low"
        case .medium: confidence = "medium"
        case .high: confidence = "high"
        @unknown default: confidence = "unknown"
        }
        return ScanObject(id: value.identifier.uuidString.lowercased(),
            category: objectCategory(value.category), dimensions: vector(value.dimensions),
            transform: columnMajor(value.transform), confidence: confidence)
    }

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
            schemaVersion: "roomplan-scan/1.1", projectId: "local-roomplan",
            jobId: "scan-" + scanID.uuidString.lowercased(), inputRevision: 0,
            capturedAt: capturedAt, roomId: room.identifier.uuidString.lowercased(),
            roomLabel: label, device: device, surfaces: surfaces, objects: room.objects.map(object)
        )
    }
}
#endif
