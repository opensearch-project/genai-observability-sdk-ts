// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/** OTel `cicd.pipeline.name` (semantic conventions, release candidate). */
export const CICD_PIPELINE_NAME_KEY = "cicd.pipeline.name";
/** OTel `cicd.pipeline.run.id`. */
export const CICD_PIPELINE_RUN_ID_KEY = "cicd.pipeline.run.id";
/** OTel `cicd.pipeline.run.url.full`. */
export const CICD_PIPELINE_RUN_URL_KEY = "cicd.pipeline.run.url.full";
export const CICD_KEYS: readonly string[] = [
  CICD_PIPELINE_NAME_KEY,
  CICD_PIPELINE_RUN_ID_KEY,
  CICD_PIPELINE_RUN_URL_KEY,
];

type Env = Record<string, string | undefined>;

function fromEnv(env: Env): Record<string, string | undefined> {
  if (env.GITHUB_ACTIONS === "true") {
    const url =
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : undefined;
    return {
      [CICD_PIPELINE_NAME_KEY]: env.GITHUB_WORKFLOW,
      [CICD_PIPELINE_RUN_ID_KEY]: env.GITHUB_RUN_ID,
      [CICD_PIPELINE_RUN_URL_KEY]: url,
    };
  }
  if (env.GITLAB_CI === "true") {
    return {
      [CICD_PIPELINE_NAME_KEY]: env.CI_PIPELINE_NAME,
      [CICD_PIPELINE_RUN_ID_KEY]: env.CI_PIPELINE_ID,
      [CICD_PIPELINE_RUN_URL_KEY]: env.CI_PIPELINE_URL,
    };
  }
  if (env.JENKINS_URL && env.BUILD_ID) {
    return {
      [CICD_PIPELINE_NAME_KEY]: env.JOB_NAME,
      [CICD_PIPELINE_RUN_ID_KEY]: env.BUILD_ID,
      [CICD_PIPELINE_RUN_URL_KEY]: env.BUILD_URL,
    };
  }
  return {};
}

/**
 * OTel `cicd.pipeline.*` attributes of the CI run this process is part of:
 * GitHub Actions, GitLab CI or Jenkins, read from their environment. `override`
 * sets or replaces keys (only `cicd.pipeline.name`, `.run.id`, `.run.url.full`;
 * others are dropped with a warning). Empty outside CI.
 */
export function ciPipelineAttributes(
  override?: Record<string, string>,
  env: Env = process.env,
): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...fromEnv(env) };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (!CICD_KEYS.includes(k)) {
      console.warn(`ciPipeline: ignoring ${JSON.stringify(k)}; expected one of ${CICD_KEYS.join(", ")}`);
      continue;
    }
    merged[k] = v;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v) out[k] = v;
  return out;
}
