import Foundation

/// Sends an exported scan straight to the reconstruction service (`POST /v1/jobs/roomplan`)
/// and polls it until the room is ready to open in /rooms. Photo bundles are tens of
/// megabytes, past what the deployed web app can accept, so the web app is not in this path.
struct ScanUploader: Sendable {
    struct Status: Sendable {
        let id: String
        let status: String
        let ready: Bool
        let error: String?
    }

    enum Failure: LocalizedError {
        case invalidServer
        case rejected(String)

        var errorDescription: String? {
            switch self {
            case .invalidServer: "Enter the Tadaima scan server address, for example https://your-service.up.railway.app."
            case .rejected(let detail): detail
            }
        }
    }

    private struct Job: Decodable {
        struct Failure: Decodable { let message: String }
        struct Artifact: Decodable { let name: String }
        let id: String
        let status: String
        let error: Failure?
        let artifacts: [Artifact]
    }

    private struct ErrorBody: Decodable {
        struct Detail: Decodable { let message: String }
        let detail: Detail
    }

    let server: URL
    let key: String

    init(server: String, key: String) throws {
        let trimmed = server.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil else {
            throw Failure.invalidServer
        }
        self.server = url
        self.key = key.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func upload(_ file: URL) async throws -> Status {
        let endpoint = server.appending(path: "v1/jobs/roomplan").appending(queryItems: [URLQueryItem(name: "render", value: "true")])
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        // Photo bundles can be tens of megabytes on venue Wi-Fi.
        request.timeoutInterval = 600
        request.setValue(file.pathExtension.lowercased() == "zip" ? "application/zip" : "application/json",
                         forHTTPHeaderField: "Content-Type")
        request.setValue(key, forHTTPHeaderField: "x-tadaima-upload-key")
        let (data, response) = try await URLSession.shared.upload(for: request, fromFile: file)
        return try decode(data, response)
    }

    func status(_ id: String) async throws -> Status {
        var request = URLRequest(url: server.appending(path: "v1/jobs/\(id)"))
        request.timeoutInterval = 30
        request.setValue(key, forHTTPHeaderField: "x-tadaima-upload-key")
        let (data, response) = try await URLSession.shared.data(for: request)
        return try decode(data, response)
    }

    private func decode(_ data: Data, _ response: URLResponse) throws -> Status {
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let detail = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.detail.message
            if code == 401 { throw Failure.rejected("The server refused the upload key. Check it matches TADAIMA_UPLOAD_KEY on the scan server.") }
            throw Failure.rejected(detail ?? "The server answered \(code).")
        }
        let job = try JSONDecoder().decode(Job.self, from: data)
        let names = Set(job.artifacts.map(\.name))
        // Same rule as the web inbox: the room opens only once the scene and model both exist.
        return Status(id: job.id, status: job.status,
                      ready: job.status == "succeeded" && names.isSuperset(of: ["draft/scene.json", "draft/scene.glb"]),
                      error: job.error?.message)
    }
}
