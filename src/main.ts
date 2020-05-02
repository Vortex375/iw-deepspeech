import { IwDeepstreamClient } from 'iw-base/modules/deepstream-client';
import { UdpDiscovery } from 'iw-base/modules/udp-discovery';
import { DeepSpeechService, DeepSpeechConfig } from './modules/deepspeech/deepspeech';

const DEEPSPEECH_CONFIG: DeepSpeechConfig = {
  modelPath: '/home/vortex/workspace/deepspeech-0.7.0-models.pbmm',
  scorerPath: '/home/vortex/workspace/deepspeech-0.7.0-models.scorer'
};

const client = new IwDeepstreamClient();
const discovery = new UdpDiscovery(client);
const deepspeech = new DeepSpeechService(client);
discovery.start({ requestPort: 6031 });

client.on('connected', () => {
  deepspeech.start(DEEPSPEECH_CONFIG);
});
