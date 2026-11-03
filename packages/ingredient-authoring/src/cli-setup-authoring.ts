import { CLI_INSTALL_MANAGERS, CLI_INSTALL_SYSTEMS, CLI_VERSION_OUTSIDE,
  type IngredientCliConfig, type CliToolVersionPolicy, type CliInstallHint } from '@recued/contracts';

export interface CliSetupField { key: string; type: 'string' | 'object' | 'array'; required: boolean; description: string; values?: readonly string[] }
type Field = Omit<CliSetupField, 'key'>;
const text = (description: string, required = false, values?: readonly string[]): Field => ({ type: 'string', required, description, ...(values ? { values } : {}) });
const fields: Record<keyof IngredientCliConfig, Field> = {
  tool: text('The authored tool name. Operation executables and probe[0] must match the launched binary, entry_point when supplied or tool otherwise. The editor chooses no program.', true),
  probe: { type: 'array', required: true, description: 'Explicit probe argv. Its first token is the launched binary. With version declared, use exactly the binary and one permitted version flag. The editor does not run the probe or choose its executable.' },
  config_dir: text('Authored configuration directory for the delegated CLI profile. Paths stay literal; source completion does not discover or create a directory.'),
  profile: text('Authored CLI profile name. The editor does not infer an installed profile or connection.'),
  package_ref: text('Authored connector package reference, commonly system_binary:<tool>. Omission derives it from tool. Install hints are separate; the editor does not install a package.'),
  entry_point: text('The launched binary, derived from tool when omitted. Probe[0] and every bound operation executable must agree. This is an explicit path/name decision.'),
  version: { type: 'object', required: false, description: 'The tool versions this authored pack was tested with and its outside policy. A declared range restricts the probe to a version request. Ranges and policy remain explicit author decisions.' },
  install: { type: 'array', required: false, description: 'Display hints for obtaining the tool: a manager/package with optional systems, or an HTTPS docs link. These are authored source hints; completing them runs no installer.' },
};
/** The canonical CLI cell keys and metadata share the same exhaustive contract map. */
export const CLI_SETUP_KEYS: readonly (keyof IngredientCliConfig)[] = Object.keys(fields) as (keyof IngredientCliConfig)[];
export const cliSetupKeyAllowed = (key: string): key is keyof IngredientCliConfig => Object.hasOwn(fields, key);
const version: Record<keyof CliToolVersionPolicy, Field> = {
  tested: { type: 'object', required: true, description: 'An inclusive oldest tested version from, and optional exclusive before boundary. Versions use one to four dotted numeric components. No version bounds are inferred.' },
  outside: text('refuse stops an action when the installed version is outside the tested range or unreadable; warn allows it and records that state. This is the pack default, which the owner can override per tool. Choose explicitly.', true, CLI_VERSION_OUTSIDE),
};
const tested: Record<keyof CliToolVersionPolicy['tested'], Field> = {
  from: text('Inclusive oldest version actually tested with this pack. Use one to four dotted numeric components. The editor does not choose a version or establish compatibility.', true),
  before: text('Exclusive upper boundary: the first untested version. It must be greater than from; omission leaves the upper range open. The editor does not invent a boundary.'),
};
const docs: Record<keyof Extract<CliInstallHint, { docs: string }>, Field> = {
  docs: text('An HTTPS installation-documentation link with no embedded username or password. A docs entry carries only docs. The author supplies the URL; the editor does not fetch it.', true),
};
const managed: Record<keyof Exclude<CliInstallHint, { docs: string }>, Field> = {
  manager: text('Choose one of the shared installation-hint managers. This labels how the owner obtains the tool; completion does not run it or select a package.', true, CLI_INSTALL_MANAGERS),
  package: text('The authored package identifier, not a shell command: up to 214 permitted letters, digits and @ / . _ + - characters, starting with a letter, digit or @.', true),
  systems: { type: 'array', required: false, values: CLI_INSTALL_SYSTEMS, description: 'Unique target systems for this hint. Omission leaves the hint unrestricted by this list; runtime display also checks which systems the manager supports. Choices are not selected from the editor host OS.' },
};
export type CliSetupSection = 'cli' | 'version' | 'tested' | 'install';
export const cliSetupFields = (section: CliSetupSection, installMode?: 'docs' | 'package'): CliSetupField[] => {
  const selected = section === 'cli' ? fields : section === 'version' ? version : section === 'tested' ? tested
    : installMode === 'docs' ? docs : installMode === 'package' ? managed : Object.fromEntries(Object.entries({ ...managed, ...docs }).map(([key, field]) => [key, { ...field, required: false }]));
  return Object.entries(selected).map(([key, field]) => ({ key, ...field }));
};
