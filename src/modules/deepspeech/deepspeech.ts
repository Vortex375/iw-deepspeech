import { Service, State } from 'iw-base/lib/registry';
import { IwDeepstreamClient } from 'iw-base/modules/deepstream-client';
import { getLogger } from 'iw-base/lib/logging';
import Ds from 'deepspeech';
import PulseAudio from 'pulseaudio2';
import MemoryStream from 'memory-stream';

const log = getLogger('DeepSpeechService');

const MAX_RECORD_DURATION = 10000; /* record max. 10 seconds */

export interface DeepSpeechConfig {
  modelPath: string;
  scorerPath?: string;
}

export class DeepSpeechService extends Service {

  private model: Ds.Model;
  private paContext = new PulseAudio();

  private stream: any;
  private memoryBuffer: MemoryStream;
  private recording: boolean;

  private recordingTimer: any;

  constructor(private ds: IwDeepstreamClient) {
    super('DeepSpeechService');
  }

  start(config: DeepSpeechConfig): Promise<void> {
    return new Promise((resolve) => {
      this.setState(State.BUSY, 'Loading DeepSpeech Model...');
      this.model = new Ds.Model(config.modelPath);
      if (config.scorerPath) {
        this.setState(State.BUSY, 'Loading Scorer...');
        this.model.enableExternalScorer(config.scorerPath);
      }
      log.debug({ beamWidth: this.model.beamWidth(), sampleRate: this.model.sampleRate() }, 'Model load complete.');

      this.setState(State.BUSY, 'Connecting to PulseAudio ...')
      this.paContext = new PulseAudio(),
      this.paContext.on('connection', () => {
        this.setState(State.OK, 'Ready for voice input');
        resolve();
      })
      this.paContext.on('error', (err) => {
        log.error({ err }, 'PulseAudio failed');
        this.setState(State.ERROR, 'PulseAudio failed');
      })
    })
    .then(() => {
      this.ds.subscribeEvent('voice-input/request-start-record', () => this.startRecording());
      this.ds.subscribeEvent('voice-input/request-stop-record', () => this.stopRecording());
    });

  }

  async stop(): Promise<void> {
    this.paContext.end();
    this.paContext = undefined;
    this.model = undefined;
    this.setState(State.INACTIVE);
  }

  private startRecording() {
    if (this.recording) {
      return;
    }
    this.recording = true;
    this.memoryBuffer = new MemoryStream();
    this.stream = this.paContext.createRecordStream({
      channels: 1,
      format: 'S16LE',
      rate: 16000
    });
    this.stream.pipe(this.memoryBuffer);
    this.setState(State.BUSY, 'Recording is active ...');
    this.ds.emitEvent('voice-input/start-record');

    this.recordingTimer = setTimeout(() => this.stopRecording(), MAX_RECORD_DURATION);
  }

  private stopRecording() {
    if ( ! this.recording) {
      return;
    }
    this.recording = false;
    if (this.recordingTimer) {
      clearTimeout(this.recordingTimer);
      this.recordingTimer = undefined;
    }

    this.stream.end();
    this.memoryBuffer.on('finish', () => {
      const text = this.runInference(this.memoryBuffer.toBuffer());
      this.ds.emitEvent('voice-input/text', text);
    });
    this.ds.emitEvent('voice-input/stop-record');
  }

  private runInference(audioBuffer: Buffer): string {
    this.setState(State.BUSY, 'Running inference ...');
    // [sic] We take half of the buffer_size because buffer is a char* while
    // LocalDsSTT() expected a short*
    const text = this.model.stt(audioBuffer);
    log.info('Inferred text:', text);
    this.setState(State.OK, 'Ready for voice input');
    return text;
  }
}