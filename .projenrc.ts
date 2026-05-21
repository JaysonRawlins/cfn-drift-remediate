import { typescript, TextFile, YamlFile } from 'projen';
import { Dependabot, DependabotScheduleInterval, GithubCredentials, VersioningStrategy } from 'projen/lib/github';
import { NpmAccess } from 'projen/lib/javascript';

const minNodeVersion = '20.19.0';

const project = new typescript.TypeScriptProject({
  name: '@jjrawlins/cfn-drift-remediate',
  description: 'CLI tool to remediate CloudFormation drift by re-importing drifted resources with their actual state',
  packageName: '@jjrawlins/cfn-drift-remediate',
  authorName: 'Jayson Rawlins',
  authorEmail: 'jayson.rawlins@gmail.com',
  license: 'Apache-2.0',
  repository: 'https://github.com/JaysonRawlins/cfn-drift-remediate.git',
  defaultReleaseBranch: 'main',
  minNodeVersion: minNodeVersion,
  projenrcTs: true,

  // CLI bin entry point
  bin: {
    'cfn-drift-remediate': 'lib/index.js',
  },

  // NPM Publishing via OIDC trusted publishing (beta dist-tag)
  releaseToNpm: true,
  npmAccess: NpmAccess.PUBLIC,
  npmTrustedPublishing: true,

  // Dependency upgrades are handled by Dependabot (lockfile-only + cooldown).
  // projen still owns package.json; major version bumps stay as manual .projenrc.ts edits.
  depsUpgrade: false,

  // Frozen-lockfile in CI so Dependabot lockfile-only PRs don't trigger cosmetic self-mutation.
  buildWorkflowOptions: {
    mutableBuild: false,
  },

  // Aikido Safe-Chain — in-flight malware scanner that proxies all package
  // manager commands (yarn/npm/pnpm/pip/etc.) through Aikido Intel.
  // Blocks malicious packages BEFORE they hit disk, BEFORE install scripts run.
  // Tokenless, free.
  //
  // SAFE_CHAIN_MINIMUM_PACKAGE_AGE_HOURS=168 raises the proxy-level cooldown
  // from the 48h default to 7 days. Critically, this applies to ALL packages
  // fetched (direct AND transitive), which closes the dependabot-core#14683
  // gap where Dependabot's manifest-level cooldown does not see transitives.
  // Empirically validated 2026-04-28 on PR #25: a transitive @typescript-eslint
  // /types@8.59.1 published <48h prior was blocked here while passing
  // Dependabot's 7-day patch cooldown on the direct dep.
  //
  // workflowBootstrapSteps injects this BEFORE setup-node. The install script
  // is OS-detection bash (no Node dependency); setup-node populates real yarn
  // afterward. Env var written via $GITHUB_ENV so subsequent install steps see it.
  //
  // Pinned to 1.5.3 (published 2026-05-12) — `releases/latest` would let
  // an AikidoSec compromise (or accidental release) trigger an unreviewed
  // rollout into every build. Bump via .projenrc.ts edit after reviewing
  // the upstream changelog.
  workflowBootstrapSteps: [
    {
      name: 'Install Aikido Safe-Chain 1.5.3 (in-flight malware scanner, 7d minimum age)',
      run: [
        'echo "SAFE_CHAIN_MINIMUM_PACKAGE_AGE_HOURS=168" >> $GITHUB_ENV',
        'curl -fsSL https://github.com/AikidoSec/safe-chain/releases/download/1.5.3/install-safe-chain.sh | sh -s -- --ci',
      ].join('\n'),
    },
  ],


  // GitHub Options
  githubOptions: {
    projenCredentials: GithubCredentials.fromApp({
      appIdSecret: 'PROJEN_APP_ID',
      privateKeySecret: 'PROJEN_APP_PRIVATE_KEY',
    }),
    mergify: false,
    pullRequestLintOptions: {
      semanticTitleOptions: {
        types: ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'revert', 'ci', 'build', 'deps', 'wip', 'release'],
      },
    },
  },

  // Runtime Dependencies
  deps: [
    '@aws-sdk/client-cloudcontrol',
    '@aws-sdk/client-cloudformation',
    '@aws-sdk/client-s3',
    '@aws-sdk/client-sts',
    '@aws-sdk/credential-providers',
    'commander',
    'yaml-cfn',
    'chalk',
    'ora',
    '@inquirer/prompts',
  ],

  // Dev Dependencies
  devDeps: [
    '@types/node',
    '@types/js-yaml',
  ],

  // TypeScript configuration
  tsconfig: {
    compilerOptions: {
      esModuleInterop: true,
      skipLibCheck: true,
      types: ['node'],
    },
  },
  tsconfigDev: {
    compilerOptions: {
      types: ['node', 'jest'],
    },
  },

  // Jest configuration - exclude integration tests by default
  jestOptions: {
    jestConfig: {
      testPathIgnorePatterns: ['/node_modules/', '/test/integration/'],
    },
  },
});

// Release workflow overrides for OIDC trusted publishing
const releaseWorkflow = project.github!.tryFindWorkflow('release')!;
releaseWorkflow.file!.addOverride('jobs.release.permissions.id-token', 'write');
releaseWorkflow.file!.addOverride('jobs.release.permissions.contents', 'write');
releaseWorkflow.file!.addOverride('jobs.release_npm.permissions.id-token', 'write');
releaseWorkflow.file!.addOverride('jobs.release_npm.permissions.contents', 'write');
// Override node-version to 24 for npm trusted publishing (requires npm 11.5.1+)
releaseWorkflow.file!.addOverride('jobs.release_npm.steps.0.with.node-version', '24');
// Set registry-url so setup-node configures .npmrc for OIDC token exchange
releaseWorkflow.file!.addOverride('jobs.release_npm.steps.0.with.registry-url', 'https://registry.npmjs.org');

// SHA-pin third-party actions used in pull_request_target contexts. A tag
// reference (@v6) can be force-pushed if the upstream repo is compromised,
// and the workflow would inherit elevated GITHUB_TOKEN scoped to PRs. SHA
// pinning makes that swap visible in a diff. First-party actions/* and
// github/* are left as version tags (lower-risk; GitHub-owned).
const prLintWorkflow = project.github!.tryFindWorkflow('pull-request-lint')!;
// amannn/action-semantic-pull-request v6.1.1
prLintWorkflow.file!.addOverride(
  'jobs.validate.steps.0.uses',
  'amannn/action-semantic-pull-request@48f256284bd46cdaab1048c3721360e808335d50',
);

// .tool-versions file for asdf
new TextFile(project, '.tool-versions', {
  lines: [
    '# ~~ Generated by projen. To modify, edit .projenrc.ts and run "npx projen".',
    `nodejs ${minNodeVersion}`,
    'yarn 1.22.22',
  ],
});

// Exclude integration test CDK app from ESLint (has its own dependencies)
project.eslint?.addIgnorePattern('test/integration/');

// Ignore runtime backup files created by cfn-drift-remediate

project.gitignore?.addPatterns(
  '.cfn-drift-remediate-backup-*',
  'plan.json',
);
project.npmignore?.addPatterns('.cfn-drift-remediate-backup-*');

// Dependabot — lockfile-only, patch+minor only, cooldown before PRs open.
// cooldown is natively supported as of projen 0.99.52 (PR #4650, 2026-04-10).
// Still need raw config mutation for:
//   - ignore.update-types (projen's DependabotIgnore type only has dependencyName + versions)
//   - github-actions ecosystem (projen's Dependabot class only manages npm)
const dependabot = new Dependabot(project.github!, {
  scheduleInterval: DependabotScheduleInterval.WEEKLY,
  versioningStrategy: VersioningStrategy.LOCKFILE_ONLY,
  labels: ['dependencies'],
  openPullRequestsLimit: 10,
  cooldown: {
    defaultDays: 7,
    semverMinorDays: 7,
    semverPatchDays: 3,
    include: ['*'],
  },
  // Group peer-coupled package families into single PRs. Without grouping,
  // Dependabot opens N parallel PRs that fail build because nested peer-deps
  // (@smithy/core, @typescript-eslint/utils) only resolve cleanly when the
  // whole family moves together.
  groups: {
    'aws-sdk': {
      patterns: ['@aws-sdk/*', '@smithy/*'],
    },
    'typescript-eslint': {
      patterns: ['@typescript-eslint/*'],
    },
  },
});

// Override the rendered ignore to add an update-types rule blocking majors.
// Keeps the projen ignore (anti-tamper boundary) that projen auto-adds via ignoreProjen.
dependabot.config.updates[0].ignore = [
  { 'dependency-name': 'projen' },
  { 'dependency-name': '*', 'update-types': ['version-update:semver-major'] },
];

// github-actions ecosystem is kept enabled for SECURITY ALERTS ONLY.
// Version-update PRs are disabled (open-pull-requests-limit: 0) because
// Dependabot would have to edit projen-generated workflow files directly,
// which trips projen's anti-tamper check (the files get regenerated on
// synth from .projenrc.ts). Empirically confirmed via PR #19 on this repo.
// To bump action versions, use project.github.actions.set() in .projenrc.ts
// or wait for a projen release that bumps its internal defaults.
dependabot.config.updates.push({
  'package-ecosystem': 'github-actions',
  'directory': '/',
  'schedule': { interval: 'weekly' },
  'open-pull-requests-limit': 0,
  'labels': ['dependencies', 'github-actions'],
});

// Security gate on PRs — calls the reusable osv-scanner workflow from
// JaysonRawlins/.github. Fails on CVSS >= 9.0. Portable alternative to
// dependency-review-action for repos without Advanced Security.
new YamlFile(project, '.github/workflows/security.yml', {
  obj: {
    name: 'security',
    on: {
      pull_request: {},
      workflow_dispatch: {},
    },
    jobs: {
      security: {
        uses: 'JaysonRawlins/.github/.github/workflows/security.yml@main',
      },
    },
  },
});

// Dependabot auto-merge — declares intent only; branch protection's required
// status checks are what actually gate the merge. The layered defense is:
//   Aikido Safe-Chain (in-flight) + osv-scanner (known CVE) + build (frozen-lockfile)
//   + cooldown (release age) + projen anti-tamper (config drift) + ignore-major.
// Auto-merge only fires when ALL required checks pass, so each layer is a veto.
//
// Uses pull_request_target so the workflow gets the elevated GITHUB_TOKEN
// (Dependabot's pull_request token is read-only). Safety: the workflow only
// calls dependabot/fetch-metadata + gh pr merge — no untrusted PR-head code
// execution. The if: github.actor guard prevents non-Dependabot actors from
// triggering it.
new YamlFile(project, '.github/workflows/dependabot-automerge.yml', {
  obj: {
    name: 'dependabot-automerge',
    on: {
      pull_request_target: {
        types: ['opened', 'synchronize', 'reopened', 'ready_for_review'],
      },
    },
    permissions: {
      'contents': 'write',
      'pull-requests': 'write',
    },
    jobs: {
      automerge: {
        'runs-on': 'ubuntu-latest',
        'if': "github.actor == 'dependabot[bot]'",
        'steps': [
          {
            name: 'Get Dependabot metadata',
            id: 'metadata',
            // SHA-pinned (v2.5.0). See the prLintWorkflow override above for rationale.
            uses: 'dependabot/fetch-metadata@21025c705c08248db411dc16f3619e6b5f9ea21a',
            with: {
              'github-token': '${{ secrets.GITHUB_TOKEN }}',
            },
          },
          {
            name: 'Enable auto-merge for safe Dependabot PRs',
            if: "steps.metadata.outputs.update-type == 'version-update:semver-patch' || steps.metadata.outputs.update-type == 'version-update:semver-minor'",
            run: 'gh pr merge --auto --squash "$PR_URL"',
            env: {
              PR_URL: '${{ github.event.pull_request.html_url }}',
              GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
            },
          },
        ],
      },
    },
  },
});

// Scheduled "unblocker" for stuck Dependabot PRs. Pattern: a Dependabot PR's
// build fails because Aikido Safe-Chain blocked a transitive that's still
// inside its minimum-age window. Auto-merge intent is registered, but since
// the required `build` check is in FAILURE state, GitHub never retries on
// its own. The PR sits stuck even after Aikido's timer clears.
//
// This workflow runs WEEKLY (Monday 09:00 UTC), finds Dependabot PRs with a
// failed `build`, inspects the failure log, and re-runs the failed build
// (NOT rebase) ONLY when the cause is Aikido's "minimum package age" check.
// Other failure modes — real breakage, malware blocks, unrecognized errors
// — are explicitly left alone so they remain visible for human review.
//
// Why rerun-not-rebase: each rebase forces Dependabot to recompute the
// lockfile against current registry state, which pulls in newer caret-
// satisfying versions that themselves trip the cooldown — chasing a
// moving target. Rerun preserves the lockfile's exact version pins; we
// just re-ask Aikido whether the existing lockfile entries have aged out.
//
// Why weekly: Aikido cooldown is 7d. A daily scoop creates more
// rebase/recompute opportunities than the cooldown window can absorb;
// weekly aligns the scoop cadence with the cooldown window. For deeply
// stuck PRs where main has moved enough to require strict-up-to-date,
// GitHub's auto-merge with allow_update_branch handles the merge itself.
new YamlFile(project, '.github/workflows/dependabot-rebase-stuck.yml', {
  obj: {
    name: 'dependabot-unblocker',
    on: {
      schedule: [
        { cron: '0 9 * * 1' },
      ],
      workflow_dispatch: {},
    },
    permissions: {
      'pull-requests': 'read',
      'actions': 'write',
    },
    jobs: {
      unblock: {
        'runs-on': 'ubuntu-latest',
        'steps': [
          {
            name: 'Rerun failed build on Aikido-cooldown-blocked Dependabot PRs',
            env: {
              GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
              REPO: '${{ github.repository }}',
            },
            run: [
              'set -euo pipefail',
              '',
              'stuck=$(gh pr list --repo "$REPO" \\',
              '  --author "app/dependabot" \\',
              '  --state open \\',
              '  --json number,statusCheckRollup \\',
              '  --jq \'.[] | select([.statusCheckRollup[] | select(.name == "build")] | any(.conclusion == "FAILURE")) | .number\')',
              '',
              'if [ -z "$stuck" ]; then',
              '  echo "No stuck Dependabot PRs."',
              '  exit 0',
              'fi',
              '',
              'for pr in $stuck; do',
              '  run_id=$(gh pr view "$pr" --repo "$REPO" --json statusCheckRollup \\',
              '    --jq \'.statusCheckRollup[] | select(.name == "build") | .detailsUrl\' \\',
              '    | grep -oE "/runs/[0-9]+" | head -1 | cut -d/ -f3)',
              '',
              '  if [ -z "$run_id" ]; then',
              '    echo "PR #$pr: no build run id, skipping"',
              '    continue',
              '  fi',
              '',
              '  log=$(gh run view "$run_id" --repo "$REPO" --log-failed 2>&1 || true)',
              '',
              '  if echo "$log" | grep -q "minimum package age"; then',
              '    echo "PR #$pr: Aikido cooldown block — rerunning failed build (preserves lockfile)"',
              '    gh run rerun "$run_id" --repo "$REPO" --failed',
              '  elif echo "$log" | grep -q "Safe-chain: blocked"; then',
              '    echo "PR #$pr: Aikido blocked (non-age, possibly malware) — leaving for human review"',
              '  else',
              '    echo "PR #$pr: build failed for unrecognized reason — leaving for human review"',
              '  fi',
              'done',
            ].join('\n'),
          },
        ],
      },
    },
  },
});

project.synth();
