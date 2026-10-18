import Foundation
import simd

@main
struct PacketMappingTests {
    static func main() throws {
        var transform = matrix_identity_float4x4
        transform.columns.0 = SIMD4<Float>(0, 0, -1, 0)
        transform.columns.2 = SIMD4<Float>(1, 0, 0, 0)
        transform.columns.3 = SIMD4<Float>(2, 1.4, -3, 1)
        let matrix = ScanWire.columnMajor(transform)
        precondition(matrix == [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 2, 1.4, -3, 1], "Matrix must remain column-major")
        let corners: [[Float]] = [[-2, -1.35, 0], [2, -1.35, 0], [2, 1.35, 0], [-2, 1.35, 0]]
        let surface = ScanSurface(id: "synthetic-wall", category: "wall", dimensions: [4, 2.7, 0],
                                  transform: matrix, confidence: "medium", parentId: nil,
                                  polygonCorners: corners, isCurved: false)
        let packet = RoomPlanPacket(schemaVersion: "roomplan-scan/1.0", projectId: "synthetic-test",
            jobId: "synthetic-scan", inputRevision: 0, capturedAt: "2026-10-18T01:00:00Z",
            roomId: "synthetic-room", roomLabel: "Synthetic export mapping test",
            device: ScanDevice(model: "test", systemVersion: "test"), surfaces: [surface])
        let data = try ScanWire.encode(packet)
        let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let surfaces = object["surfaces"] as! [[String: Any]]
        precondition(surfaces[0]["parentId"] is NSNull, "Missing native parent must be explicit JSON null")
        precondition((surfaces[0]["isCurved"] as? Bool) == false)
        precondition((surfaces[0]["polygonCorners"] as! [[NSNumber]]).map { $0.map(\.floatValue) } == corners,
                     "Polygon corners must remain local, without world transformation")
        precondition((surfaces[0]["transform"] as! [NSNumber]).map(\.floatValue) == matrix)
        let roundTrip = try JSONDecoder().decode(RoomPlanPacket.self, from: data)
        precondition(roundTrip.surfaces[0].dimensions == [4, 2.7, 0])
        let invalid = ScanSurface(id: "bad", category: "wall", dimensions: [.nan, 1, 0],
                                 transform: matrix, confidence: "unknown", parentId: nil,
                                 polygonCorners: [], isCurved: false)
        let invalidPacket = RoomPlanPacket(schemaVersion: packet.schemaVersion, projectId: packet.projectId,
            jobId: packet.jobId, inputRevision: 0, capturedAt: packet.capturedAt, roomId: packet.roomId,
            roomLabel: packet.roomLabel, device: packet.device, surfaces: [invalid])
        do { _ = try ScanWire.encode(invalidPacket); fatalError("Nonfinite dimensions must fail encoding") }
        catch EncodingError.invalidValue { /* Expected: no invalid JSON geometry. */ }
        print("PASS: column-major transform, local polygon coordinates, explicit null parent, curved flag, JSON round-trip, nonfinite rejection")
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--emit-fixture" {
            let url = URL(fileURLWithPath: CommandLine.arguments[2])
            try ScanWire.encode(syntheticRoom()).write(to: url, options: .atomic)
            print("Wrote synthetic fixture (not a device capture): \(url.path)")
        } else if CommandLine.arguments.count != 1 {
            fatalError("Usage: packet-tests [--emit-fixture /private/synthetic.json]")
        }
    }

    static func syntheticRoom() -> RoomPlanPacket {
        func matrix(x: Float, y: Float, z: Float, dx: Float, dz: Float) -> [Float] {
            var value = matrix_identity_float4x4
            value.columns.0 = SIMD4<Float>(dx, 0, dz, 0)
            value.columns.1 = SIMD4<Float>(0, 1, 0, 0)
            value.columns.2 = SIMD4<Float>(-dz, 0, dx, 0)
            value.columns.3 = SIMD4<Float>(x, y, z, 1)
            return ScanWire.columnMajor(value)
        }
        func surface(_ id: String, _ category: String, _ width: Float, _ height: Float,
                     x: Float, y: Float, z: Float, dx: Float, dz: Float, parent: String? = nil) -> ScanSurface {
            ScanSurface(id: id, category: category, dimensions: [width, height, 0],
                transform: matrix(x: x, y: y, z: z, dx: dx, dz: dz), confidence: "high", parentId: parent,
                polygonCorners: [[-width / 2, -height / 2, 0], [width / 2, -height / 2, 0],
                                 [width / 2, height / 2, 0], [-width / 2, height / 2, 0]], isCurved: false)
        }
        let surfaces = [
            surface("synthetic-wall-a", "wall", 4.2, 2.7, x: 2.1, y: 1.35, z: 0, dx: 1, dz: 0),
            surface("synthetic-wall-b", "wall", 3.5, 2.7, x: 4.2, y: 1.35, z: 1.75, dx: 0, dz: 1),
            surface("synthetic-wall-c", "wall", 4.2, 2.7, x: 2.1, y: 1.35, z: 3.5, dx: -1, dz: 0),
            surface("synthetic-wall-d", "wall", 3.5, 2.7, x: 0, y: 1.35, z: 1.75, dx: 0, dz: -1),
            surface("synthetic-door", "door", 0.9, 2.1, x: 1.2, y: 1.05, z: 0, dx: 1, dz: 0, parent: "synthetic-wall-a"),
            surface("synthetic-window", "window", 1.2, 1.1, x: 4.2, y: 1.5, z: 1.75, dx: 0, dz: 1, parent: "synthetic-wall-b"),
        ]
        return RoomPlanPacket(schemaVersion: "roomplan-scan/1.0", projectId: "synthetic-swift",
            jobId: "synthetic-swift-scan", inputRevision: 0, capturedAt: "2026-10-18T01:00:00Z",
            roomId: "synthetic-swift-room", roomLabel: "Synthetic Swift 4.2 by 3.5 meter protocol fixture",
            device: ScanDevice(model: "synthetic-test-no-device", systemVersion: "test"), surfaces: surfaces)
    }
}
