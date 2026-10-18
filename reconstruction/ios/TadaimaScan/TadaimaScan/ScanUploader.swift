import Foundation

/// Sends an exported scan to the Tadaima web app (`POST /api/scans`) and polls the
/// reconstruction until the room is ready to open in /rooms on the laptop.
struct ScanUploader: Sendable {
    struct Status: Decodable, Sendable {
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
            case .invalidServer: "Enter the Tadaima server address, for example http://your-mac.local:3000."
            case .rejected(let detail): detail
            }
        }
    }

    private struct ErrorBody: Decodable { let error: String }

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
        var request = URLRequest(url: server.appending(path: "api/scans"))
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
        var request = URLRequest(url: server.appending(path: "api/scans/\(id)"))
        request.timeoutInterval = 30
        request.setValue(key, forHTTPHeaderField: "x-tadaima-upload-key")
        let (data, response) = try await URLSession.shared.data(for: request)
        return try decode(data, response)
    }

    private func decode(_ data: Data, _ response: URLResponse) throws -> Status {
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let detail = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            if code == 401 { throw Failure.rejected("The server refused the upload key. Check it matches TADAIMA_SCAN_UPLOAD_KEY on the Mac.") }
            throw Failure.rejected(detail ?? "The server answered \(code).")
        }
        return try JSONDecoder().decode(Status.self, from: data)
    }
}
