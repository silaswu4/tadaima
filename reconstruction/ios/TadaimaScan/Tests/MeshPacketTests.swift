import Foundation

@main
struct MeshPacketTests {
    static let identity: [Float] = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
    static let vertices: [[Float]] = [[0,0,0], [1,0,0], [0,1,0]]
    static func anchor(transform: [Float] = identity, vertices: [[Float]] = vertices,
                       faces: [[Int]] = [[0,1,2]], classifications: [Int] = [0]) -> ScanMeshAnchorPacket {
        ScanMeshAnchorPacket(id: "mesh-00000000-0000-4000-8000-000000000001", transform: transform,
            vertices: vertices, faces: faces, classifications: classifications)
    }
    static func packet(_ anchors: [ScanMeshAnchorPacket]) -> ScanMeshPacket {
        ScanMeshPacket(projectId: "synthetic-test", jobId: "synthetic-scan", inputRevision: 0, anchors: anchors)
    }
    static func rejects(_ label: String, _ action: () throws -> Void) {
        do { try action() } catch { return }
        fatalError("Expected rejection: \(label)")
    }
    static func main() throws {
        let data = try ScanMeshWire.encode(packet([anchor()]))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        precondition(Set(json.keys) == ["schemaVersion", "projectId", "jobId", "inputRevision", "coordinateSystem", "captureMethod", "anchors"])
        precondition(json["schemaVersion"] as? String == "roomplan-mesh/1.0")
        var translated = identity; translated[12] = 12; translated[13] = -1.2
        try ScanMeshWire.validate(packet([anchor(transform: translated)]))
        rejects("empty scan") { try ScanMeshWire.validate(packet([])) }
        rejects("repeated anchors") { try ScanMeshWire.validate(packet([anchor(), anchor()])) }
        rejects("nonfinite vertex") { try ScanMeshWire.validate(packet([anchor(vertices: [[.nan,0,0], [1,0,0], [0,1,0]])])) }
        rejects("vertex bounds") { try ScanMeshWire.validate(packet([anchor(vertices: [[10_001,0,0], [1,0,0], [0,1,0]])])) }
        rejects("bad index") { try ScanMeshWire.validate(packet([anchor(faces: [[0,1,3]])])) }
        rejects("negative index") { try ScanMeshWire.validate(packet([anchor(faces: [[0,1,-1]])])) }
        rejects("repeated triangle index") { try ScanMeshWire.validate(packet([anchor(faces: [[0,1,1]])])) }
        rejects("zero area") { try ScanMeshWire.validate(packet([anchor(vertices: [[0,0,0], [1,0,0], [2,0,0]])])) }
        rejects("duplicate opposite-winding face") {
            try ScanMeshWire.validate(packet([anchor(faces: [[0,1,2], [2,1,0]], classifications: [0,0])]))
        }
        rejects("classification length") { try ScanMeshWire.validate(packet([anchor(classifications: [])])) }
        rejects("classification value") { try ScanMeshWire.validate(packet([anchor(classifications: [8])])) }
        var reflected = identity; reflected[0] = -1
        rejects("reflection") { try ScanMeshWire.validate(packet([anchor(transform: reflected)])) }
        var scaled = identity; scaled[0] = 2
        rejects("nonrigid") { try ScanMeshWire.validate(packet([anchor(transform: scaled)])) }
        var projective = identity; projective[3] = 0.2
        rejects("projective transform") { try ScanMeshWire.validate(packet([anchor(transform: projective)])) }
        rejects("face limit") { try ScanMeshWire.validate(packet([anchor(faces: Array(repeating: [0,1,2], count: ScanMeshWire.maximumFaces + 1), classifications: Array(repeating: 0, count: ScanMeshWire.maximumFaces + 1))])) }
        rejects("vertex limit") { try ScanMeshWire.validate(packet([anchor(vertices: Array(repeating: [0,0,0], count: ScanMeshWire.maximumVertices + 1))])) }
        print("PASS: synthetic mesh identity, rigid transforms, finite vertices, triangle indices, degeneracy, classification and geometry bounds")
    }
}
