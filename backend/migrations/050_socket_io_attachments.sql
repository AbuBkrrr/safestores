-- Used by @socket.io/postgres-adapter to pass large realtime payloads
-- between backend copies (load-balanced deployments).
CREATE TABLE IF NOT EXISTS socket_io_attachments (
  id BIGSERIAL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  payload BYTEA
);
