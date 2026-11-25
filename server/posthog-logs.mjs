import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';

const missingConfigurationWarning = (name) => `${name} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${name} is configured`;

/** Create an isolated OTLP logger that exports only records emitted through this module. */
export function createPostHogLogger(env = process.env) {
  const key = env.POSTHOG_KEY;
  const host = env.POSTHOG_HOST;
  if (!key || !host) {
    if (env.NODE_ENV !== 'production') {
      if (!key) console.warn(missingConfigurationWarning('POSTHOG_KEY'));
      if (!host) console.warn(missingConfigurationWarning('POSTHOG_HOST'));
    }
    return { emit: () => {}, shutdown: async () => {} };
  }

  const exporter = new OTLPLogExporter({
    url: `${String(host).replace(/\/+$/, '')}/i/v1/logs`,
    headers: { Authorization: `Bearer ${key}` },
  });
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      'service.name': 'agent-ready-check-server',
      'deployment.environment': env.NODE_ENV || 'development',
    }),
    processors: [new BatchLogRecordProcessor(exporter)],
  });
  const logger = provider.getLogger('agent-ready-check.posthog');

  return {
    emit: (severityText, body, attributes = {}) => {
      try { logger.emit({ severityText, body, attributes }); } catch { /* Logging must not interrupt scans. */ }
    },
    shutdown: async () => {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        provider.shutdown().catch(() => {}).finally(() => { clearTimeout(timeout); resolve(); });
      });
    },
  };
}
