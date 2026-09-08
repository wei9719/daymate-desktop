import process from "node:process";

export default function requireCloudRunner() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_OS !== "Linux"
  ) {
    throw new Error(
      "Run browser smoke tests in the GitHub UI smoke workflow. Local --list discovery is safe and does not launch a browser.",
    );
  }
}
