# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial release of `opensearch-genai-observability-sdk-ts`
- `observe()` function wrapper with overloads for tracing LLM operations
- `withObserve()` context-based tracing
- `enrich()` for adding GenAI semantic convention attributes to spans
- `register()` for configuring OpenTelemetry pipeline (HTTP/gRPC, batch/simple)
- `score()` for submitting evaluation scores as OTel spans
- `Benchmark` class and `evaluate()` function for evaluation/scoring
- `AWSSigV4OTLPExporter` for AWS SigV4-authenticated OTLP export
- `OpenSearchTraceRetriever` for querying traces from OpenSearch
