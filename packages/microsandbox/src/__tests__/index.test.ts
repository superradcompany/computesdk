import { runProviderTestSuite } from '@computesdk/test-utils';
import { microsandbox } from '../index';

// Integration boots real local microVMs (needs KVM / Hypervisor.framework and the
// microsandbox runtime); unit mode exercises the suite against the shared mock.
const runIntegration =
  process.env.MSB_RUN_INTEGRATION === '1' ||
  process.env.MSB_RUN_INTEGRATION === 'true';
const skipIntegration = !runIntegration;

const provider = microsandbox({
  image: process.env.MSB_TEST_IMAGE || 'alpine:3.21',
  cpus: 1,
  memoryMib: 512,
});

runProviderTestSuite({
  name: 'microsandbox',
  provider,
  supportsFilesystem: true,
  // getUrl needs boot-time port maps; the suite's generic probe has none declared.
  supportsGetUrl: false,
  skipIntegration,
});
