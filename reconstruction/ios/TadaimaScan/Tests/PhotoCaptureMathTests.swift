import Foundation

@main
struct PhotoCaptureMathTests {
    static func main() {
        let intrinsic: [Float] = [1000, 0, 0, 0, 900, 0, 640, 360, 1]
        let scaled = ScanPhotoMath.rescaledIntrinsics(intrinsic, sourceWidth: 1280, sourceHeight: 720,
                                                     width: 640, height: 360)
        precondition(scaled == [500, 0, 0, 0, 450, 0, 320, 180, 1])
        // Rounded output dimensions may scale x and y differently; both rows must be adjusted.
        let uneven = ScanPhotoMath.rescaledIntrinsics(intrinsic, sourceWidth: 1280, sourceHeight: 720,
                                                     width: 640, height: 361)!
        precondition(uneven[0] == 500 && abs(uneven[4] - 451.25) < 0.001)
        precondition(uneven[6] == 320 && abs(uneven[7] - 180.5) < 0.001 && uneven[8] == 1)
        precondition(ScanPhotoMath.rescaledIntrinsics(intrinsic, sourceWidth: 0, sourceHeight: 720,
                                                     width: 640, height: 360) == nil)
        precondition(ScanPhotoMath.rescaledIntrinsics([.nan], sourceWidth: 1, sourceHeight: 1,
                                                     width: 1, height: 1) == nil)
        let identity: [Float] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        let zero = ScanPhotoMath.displacement(identity, identity)!
        precondition(zero.distance == 0 && zero.angle == 0)
        var translated = identity
        translated[12] = 3; translated[13] = 4
        precondition(ScanPhotoMath.displacement(identity, translated)!.distance == 5)
        // 90-degree Y rotation; translation must not influence the angle.
        let rotation: [Float] = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 12, 3, -6, 1]
        precondition(abs(ScanPhotoMath.displacement(identity, rotation)!.angle - .pi / 2) < 0.0001)
        // A roll also changes camera appearance and must count as a new view.
        let roll: [Float] = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        precondition(abs(ScanPhotoMath.displacement(identity, roll)!.angle - .pi / 2) < 0.0001)
        precondition(ScanPhotoMath.displacement([], identity) == nil)
        var bad = identity; bad[12] = .infinity
        precondition(ScanPhotoMath.displacement(identity, bad) == nil)
        print("Photo capture math tests passed")
    }
}
