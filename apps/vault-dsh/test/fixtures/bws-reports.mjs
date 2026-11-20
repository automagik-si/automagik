// stderr captured from bws 2.1.0 against HTTPS loopback.
export const bwsReports = {
  invalidClient: `Error:\x20
   0: Received error message from server: [400 Bad Request] {"error":"invalid_client"}

Location:
   crates/bws/src/main.rs:107

Backtrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.
Run with RUST_BACKTRACE=full to include source snippets.
`,
  invalidGrant: `Error:\x20
   0: Received error message from server: [400 Bad Request] {"error":"invalid_grant"}

Location:
   crates/bws/src/main.rs:107

Backtrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.
Run with RUST_BACKTRACE=full to include source snippets.
`,
  unauthorized: `Error:\x20
   0: Received error message from server: [401 Unauthorized] {"error":"unauthorized"}

Location:
   crates/bws/src/main.rs:107

Backtrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.
Run with RUST_BACKTRACE=full to include source snippets.
`,
  notFound: `Error:\x20
   0: Received error message from server: [404 Not Found] {"message":"Secret not found."}

Location:
   crates/bws/src/main.rs:107

Backtrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.
Run with RUST_BACKTRACE=full to include source snippets.
`,
  rateLimited: `Error:\x20
   0: Received error message from server: [429 Too Many Requests] {"message":"Too many requests."}

Location:
   crates/bws/src/main.rs:107

Backtrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.
Run with RUST_BACKTRACE=full to include source snippets.
`,
  outage: `Error:\x20
   0: Received error message from server: [500 Internal Server Error] {"message":"Service unavailable."}

Location:
   crates/bws/src/main.rs:107

Backtrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.
Run with RUST_BACKTRACE=full to include source snippets.
`,
  closed: `Error:\x20
   0: error sending request for url (https://127.0.0.1:<port>/identity/connect/token)
   1: client error (Connect)
   2: tcp connect error
   3: Connection refused (os error 111)

Location:
   crates/bws/src/main.rs:107

Backtrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.
Run with RUST_BACKTRACE=full to include source snippets.
`,
}
