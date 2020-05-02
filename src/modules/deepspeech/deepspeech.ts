import { Service, State } from 'iw-base/lib/registry';
import { IwDeepstreamClient } from 'iw-base/modules/deepstream-client';
import { getLogger } from 'iw-base/lib/logging';
import Ds from 'deepspeech';
import Sox from 'sox-stream';
import PulseAudio from 'pulseaudio2';
import MemoryStream from 'memory-stream';
// Speaker typedefs appear to be broken
// tslint:disable-next-line: no-var-requires
const Speaker = require('speaker');

const log = getLogger('DeepSpeechService');

const MAX_RECORD_DURATION = 10000; /* record max. 10 seconds */

export interface DeepSpeechConfig {
  modelPath: string;
  scorerPath?: string;
}

export class DeepSpeechService extends Service {

  private model: Ds.Model;
  private paContext = new PulseAudio();

  private recordStream: any;
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
      });
      this.paContext.on('error', (err) => {
        log.error({ err }, 'PulseAudio failed');
        this.setState(State.ERROR, 'PulseAudio failed');
      });
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
    this.recordStream = this.paContext.createRecordStream({
      channels: 1,
      format: 'S24LE',
      rate: 48000
    });
    const transform = Sox({
      input: {
        type: 's24',
        rate: 48000,
        endian: 'little',
        channels: 1
      },
      output: {
        type: 's16',
        rate: 16000,
        endian: 'little',
        channels: 1
      },
      effects: [
        // ['noisered'], ['/home/vortex/workspace/audio/speech.noise-profile'], ['0.3'],
        ['gain'], ['-n'], ['-1']
      ]
    });
    transform.on('error', (err) => {
      /* sox likes to print stuff to stderr which is treated as 'error' */
      log.warn('sox', err);
    });
    this.memoryBuffer = new MemoryStream();
    this.recordStream.pipe(transform);
    transform.pipe(this.memoryBuffer);

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

    this.recordStream.end();
    this.memoryBuffer.on('finish', () => {
      log.debug('playing back audio');
      const buffer = this.memoryBuffer.toBuffer();
      const speaker = new Speaker({
        channels: 1,
        bitDepth: 16,
        signed: true,
        sampleRate: 16000
      });
      speaker.end(buffer);
      log.debug('playback ok');
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