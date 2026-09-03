import { startTelemetry } from '@mcpgateway/telemetry';

// Loaded via `node --import` so the SDK patches http before the application
// module is evaluated.
startTelemetry({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'mcp-salesforce' });
