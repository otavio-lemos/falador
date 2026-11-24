// falador-nodes — risco por caminho argv (argv0 + subcomando), não por prefixo de string (ADR-007)
import { basename } from 'node:path';

export type ArgvRisk = 'read' | 'mutating' | 'unknown';

export interface ArgvRiskResult {
  risk: ArgvRisk;
  path: string;
}

interface BinaryRule {
  read?: string[][];
  mutating?: string[][];
  /** binário conhecido sem caminho reconhecido: fail-closed, salvo leitores puros */
  defaultRisk?: 'read' | 'mutating';
}

const K8S_RULE: BinaryRule = {
  read: [
    ['get'], ['describe'], ['logs'], ['explain'], ['top'], ['diff'], ['api-resources'],
    ['api-versions'], ['cluster-info'], ['config', 'get'], ['config', 'view'], ['auth', 'can-i'],
  ],
  mutating: [
    ['apply'], ['delete'], ['patch'], ['scale'], ['rollout'], ['exec'], ['create'],
    ['edit'], ['replace'], ['label'], ['annotate'], ['set'], ['drain'], ['cordon'], ['uncordon'],
  ],
};

const RULES: Record<string, BinaryRule> = {
  systemctl: {
    read: [
      ['status'], ['is-active'], ['is-enabled'], ['is-failed'], ['show'], ['cat'],
      ['list-units'], ['list-unit-files'], ['list-timers'], ['list-dependencies'], ['get-default'], ['help'],
    ],
    mutating: [
      ['start'], ['stop'], ['restart'], ['reload'], ['enable'], ['disable'], ['mask'],
      ['unmask'], ['daemon-reload'], ['reset-failed'], ['set-default'],
    ],
  },
  journalctl: {
    mutating: [['--vacuum-*'], ['--rotate'], ['--flush'], ['--sync']],
    defaultRisk: 'read',
  },
  kubectl: K8S_RULE,
  oc: K8S_RULE,
  helm: {
    read: [['list'], ['ls'], ['status'], ['show'], ['get'], ['history'], ['search'], ['version'], ['help'], ['template']],
    mutating: [['install'], ['upgrade'], ['rollback'], ['uninstall'], ['delete'], ['repo', 'add'], ['repo', 'remove']],
  },
  docker: {
    read: [['ps'], ['images'], ['logs'], ['inspect'], ['info'], ['version'], ['stats'], ['top'], ['port']],
    mutating: [
      ['run'], ['stop'], ['rm'], ['exec'], ['start'], ['restart'], ['kill'], ['pull'],
      ['push'], ['build'], ['create'], ['pause'], ['unpause'], ['rmi'], ['compose', 'up'], ['compose', 'down'],
    ],
  },
  'docker-compose': {
    read: [['ps'], ['logs'], ['config'], ['images'], ['top'], ['version']],
    mutating: [['up'], ['down'], ['restart'], ['build'], ['pull'], ['run'], ['exec'], ['stop'], ['start'], ['kill']],
  },
  ip: {
    read: [
      ['link', 'show'], ['link', 'list'], ['addr', 'show'], ['addr', 'list'], ['address', 'show'],
      ['route', 'show'], ['route', 'list'], ['neigh', 'show'],
    ],
    mutating: [
      ['link', 'set'], ['link', 'add'], ['link', 'del'], ['link', 'delete'],
      ['addr', 'add'], ['addr', 'del'], ['addr', 'delete'], ['address', 'add'], ['address', 'del'],
      ['route', 'add'], ['route', 'del'], ['route', 'delete'], ['route', 'replace'], ['neigh', 'add'], ['neigh', 'del'],
    ],
  },
  ss: {
    mutating: [['-K'], ['--kill']],
    defaultRisk: 'read',
  },
  git: {
    read: [['status'], ['log'], ['diff'], ['show'], ['blame'], ['ls-remote'], ['rev-parse'], ['help']],
    mutating: [
      ['push'], ['reset'], ['checkout'], ['clean'], ['commit'], ['merge'], ['rebase'],
      ['pull'], ['add'], ['rm'], ['stash'], ['revert'], ['cherry-pick'], ['clone'], ['init'],
    ],
  },
  terraform: {
    read: [['show'], ['output'], ['validate'], ['list'], ['version'], ['providers']],
    mutating: [['apply'], ['destroy'], ['init'], ['refresh'], ['import'], ['plan'], ['state'], ['force-unlock']],
  },
  ansible: {
    read: [['--version'], ['--help']],
    mutating: [['-m'], ['--module-name']],
  },
  'ansible-playbook': { defaultRisk: 'mutating' },
  npm: {
    read: [['ls'], ['list'], ['view'], ['whoami'], ['help'], ['outdated'], ['audit'], ['config', 'get']],
    mutating: [
      ['install'], ['i'], ['add'], ['remove'], ['uninstall'], ['ci'], ['update'], ['publish'],
      ['unpublish'], ['run'], ['exec', '--'],
    ],
  },
  make: {
    read: [['-n'], ['--dry-run'], ['--just-print'], ['--recon']],
    defaultRisk: 'mutating',
  },
};

export function classifyArgvRisk(argv: string[]): ArgvRiskResult {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string' || !argv[0]) {
    return { risk: 'unknown', path: '' };
  }
  const bin = basename(argv[0]).toLowerCase();
  const rule = RULES[bin];
  if (!rule) return { risk: 'unknown', path: bin };

  const rest = argv.slice(1).map((arg) => String(arg).toLowerCase());
  const matches = (pattern: string[]): boolean =>
    pattern.length <= rest.length &&
    pattern.every((token, i) => {
      const expected = token.toLowerCase();
      return token.endsWith('*') ? rest[i].startsWith(expected.slice(0, -1)) : rest[i] === expected;
    });
  const pathFor = (pattern: string[]): string =>
    [bin, ...pattern.map((token, i) => (token.endsWith('*') ? rest[i] : token))].join(' ');

  for (const pattern of rule.mutating ?? []) {
    if (matches(pattern)) return { risk: 'mutating', path: pathFor(pattern) };
  }
  for (const pattern of rule.read ?? []) {
    if (matches(pattern)) return { risk: 'read', path: pathFor(pattern) };
  }
  return { risk: rule.defaultRisk ?? 'mutating', path: bin };
}
