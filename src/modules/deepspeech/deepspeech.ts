import { Service, State } from 'iw-base/lib/registry';
import { IwDeepstreamClient } from 'iw-base/modules/deepstream-client';
import { getLogger } from 'iw-base/lib/logging';
import Ds from 'deepspeech';
import Sox from 'sox-stream';
import { RtAudio, RtAudioFormat } from 'audify';
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
  private rtAudio: RtAudio;

  private recording: boolean;
  private transformStream: NodeJS.ReadWriteStream;
  private memoryBuffer: MemoryStream;

  private recordingTimer: NodeJS.Timeout;

  constructor(private ds: IwDeepstreamClient) {
    super('DeepSpeechService');
  }

  async start(config: DeepSpeechConfig) {
    this.setState(State.BUSY, 'Loading DeepSpeech Model...');
    this.model = new Ds.Model(config.modelPath);
    if (config.scorerPath) {
      this.setState(State.BUSY, 'Loading Scorer...');
      this.model.enableExternalScorer(config.scorerPath);
    }
    log.debug({ beamWidth: this.model.beamWidth(), sampleRate: this.model.sampleRate() }, 'Model load complete.');

    this.setState(State.BUSY, 'Setting up RtAudio ...');
    this.rtAudio = new RtAudio();
    const devices = this.rtAudio.getDevices();
    const inputDeviceId = this.rtAudio.getDefaultInputDevice();
    log.debug({ deviceInfo: devices[inputDeviceId] }, `using device ${devices[inputDeviceId].name} via ${this.rtAudio.getApi()}`);

    this.ds.subscribeEvent('voice-input/request-start-record', () => this.startRecording());
    this.ds.subscribeEvent('voice-input/request-stop-record', () => this.stopRecording());

    this.setState(State.OK, 'Ready for voice input');
  }

  async stop(): Promise<void> {
    if (this.recording) {
      this.rtAudio.closeStream();
    }
    this.recording = false;
    this.rtAudio = undefined;
    this.model = undefined;
    this.setState(State.INACTIVE);
  }

  private startRecording() {
    if (this.recording) {
      return;
    }
    this.recording = true;
    this.rtAudio.openStream(
      undefined, /* audio output device (unused) */
      {
        deviceId: this.rtAudio.getDefaultInputDevice(),
        nChannels: 1
      },
      RtAudioFormat.RTAUDIO_FLOAT32,
      48000, /* sample rate */
      2400, /* frame size (50ms) */
      'Iw DeepSpeech Record Stream', /* stream name */
      (pcm) => this.transformStream.write(pcm), /* input callback */
      undefined /* output callback (unused) */
    );
    this.transformStream = Sox({
      input: {
        type: 'f32',
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
        ['gain'], ['-n'], ['-3']
      ]
    });
    this.transformStream.on('error', (err) => {
      /* sox likes to print stuff to stderr which is treated as 'error' */
      log.warn('sox', err);
    });
    this.memoryBuffer = new MemoryStream();
    this.transformStream.pipe(this.memoryBuffer);
    this.rtAudio.start();

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

    this.rtAudio.stop();
    this.rtAudio.closeStream();
    this.transformStream.end();
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
      speaker.on('close', () => {
        log.debug('playback ok');
        const text = this.runInference(this.memoryBuffer.toBuffer());
        this.ds.emitEvent('voice-input/text', text);
      });
    });
    this.ds.emitEvent('voice-input/stop-record');
  }

  private runInference(audioBuffer: Buffer): string {
    this.setState(State.BUSY, 'Running inference ...');
    const text = this.model.stt(audioBuffer);
    log.info('Inferred text:', text);
    this.setState(State.OK, 'Ready for voice input');
    return text;
  }
}
