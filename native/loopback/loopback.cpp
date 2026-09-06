// Captura del sonido del sistema por WASAPI, en crudo y a la salida estandar.
//
// Windows no ofrece ningun dispositivo con el que FFmpeg pueda grabar lo que
// suena: por dshow solo se ven microfonos. Chromium si sabe hacerlo sobre el
// papel, pero en algunas maquinas su servicio de audio no llega a abrir el
// bucle y devuelve NotReadableError sin mas explicacion, sin que haya nada que
// tocar desde JavaScript.
//
// Esto es la via directa y documentada: WASAPI en modo bucle sobre el
// dispositivo de salida predeterminado, que es la misma que usan los
// programas de grabacion para el "audio de escritorio". No se toca ningun
// otro proceso ni se instala nada en el sistema; el programa se limita a
// pedirle a Windows una copia de lo que ya esta sonando.
//
// Salida: PCM entrelazado de 16 bits con signo, 48 kHz, estereo. Es el formato
// que espera la tuberia de audio de Clipper, para que FFmpeg lo lea tal cual.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <stdio.h>
#include <io.h>
#include <fcntl.h>
#include <vector>
#include <cmath>

namespace {

const int kOutRate = 48000;
const int kOutChannels = 2;
// Cuanto se le pide a Windows de margen. Diez veces el intervalo tipico basta
// para que un tiron del sistema no haga perder audio.
const REFERENCE_TIME kBufferDuration = 2000000;  // 200 ms en unidades de 100 ns

struct Format {
  int rate;
  int channels;
  int bitsPerSample;
  bool isFloat;
  DWORD channelMask;
};

// Coeficientes de mezcla a estereo, uno por canal de origen.
struct Downmix {
  std::vector<float> left;
  std::vector<float> right;
};

/**
 * Reparte los canales del sistema en dos.
 *
 * Muchos cascos se presentan como 7.1 aunque solo tengan dos altavoces, y en
 * ese caso los juegos mandan sonido por el canal central y los traseros. Coger
 * solo los dos frontales dejaria fuera casi todo lo que se oye: las voces y
 * buena parte de los efectos van por el centro.
 *
 * Se usa la mezcla habitual (centro y traseros a -3 dB) y se normaliza por la
 * suma de coeficientes, que evita saturar sin tener que recortar despues.
 */
Downmix BuildDownmix(const Format& fmt) {
  Downmix mix;
  mix.left.assign(fmt.channels, 0.0f);
  mix.right.assign(fmt.channels, 0.0f);

  if (fmt.channels == 1) {
    mix.left[0] = 1.0f;
    mix.right[0] = 1.0f;
    return mix;
  }

  if (fmt.channels == 2 || fmt.channelMask == 0) {
    mix.left[0] = 1.0f;
    mix.right[1 % fmt.channels] = 1.0f;
    return mix;
  }

  // Orden estandar de WAVE_FORMAT_EXTENSIBLE: los canales aparecen en el orden
  // de los bits de la mascara, asi que se recorre la mascara contando.
  const float kSide = 0.7071f;
  int index = 0;
  for (int bit = 0; bit < 18 && index < fmt.channels; bit++) {
    const DWORD flag = 1u << bit;
    if ((fmt.channelMask & flag) == 0) continue;
    switch (flag) {
      case SPEAKER_FRONT_LEFT:
        mix.left[index] = 1.0f;
        break;
      case SPEAKER_FRONT_RIGHT:
        mix.right[index] = 1.0f;
        break;
      case SPEAKER_FRONT_CENTER:
        mix.left[index] = kSide;
        mix.right[index] = kSide;
        break;
      case SPEAKER_BACK_LEFT:
      case SPEAKER_SIDE_LEFT:
        mix.left[index] = kSide;
        break;
      case SPEAKER_BACK_RIGHT:
      case SPEAKER_SIDE_RIGHT:
        mix.right[index] = kSide;
        break;
      default:
        // El subgrave y el resto se descartan: en estereo solo aportarian
        // retumbe y riesgo de saturar.
        break;
    }
    index++;
  }

  // Normalizacion por potencia y no por suma.
  //
  // Dividir por la suma de coeficientes supone que todos los canales suenan a
  // tope y en fase a la vez, cosa que no pasa: en un 7.1 dejaba la grabacion
  // diez decibelios por debajo, medido. Dividiendo por la raiz de la suma de
  // cuadrados se conserva el volumen percibido de canales independientes, que
  // es lo que hay en un juego, y sigue habiendo margen de sobra ante picos.
  float powerLeft = 0.0f;
  float powerRight = 0.0f;
  for (int i = 0; i < fmt.channels; i++) {
    powerLeft += mix.left[i] * mix.left[i];
    powerRight += mix.right[i] * mix.right[i];
  }
  const float normLeft = powerLeft > 1.0f ? std::sqrt(powerLeft) : 1.0f;
  const float normRight = powerRight > 1.0f ? std::sqrt(powerRight) : 1.0f;
  for (int i = 0; i < fmt.channels; i++) {
    mix.left[i] /= normLeft;
    mix.right[i] /= normRight;
  }
  return mix;
}

/** Lee una muestra del bufer de Windows y la deja normalizada entre -1 y 1. */
float ReadSample(const BYTE* data, const Format& fmt, int frame, int channel) {
  const int index = frame * fmt.channels + channel;
  if (fmt.isFloat) {
    return reinterpret_cast<const float*>(data)[index];
  }
  if (fmt.bitsPerSample == 16) {
    return reinterpret_cast<const short*>(data)[index] / 32768.0f;
  }
  if (fmt.bitsPerSample == 32) {
    return reinterpret_cast<const int*>(data)[index] / 2147483648.0f;
  }
  if (fmt.bitsPerSample == 24) {
    const BYTE* p = data + index * 3;
    int value = (p[2] << 24) | (p[1] << 16) | (p[0] << 8);
    return (value >> 8) / 8388608.0f;
  }
  return 0.0f;
}

short ToInt16(float sample) {
  if (sample > 1.0f) sample = 1.0f;
  if (sample < -1.0f) sample = -1.0f;
  return static_cast<short>(sample * 32767.0f);
}

}  // namespace

int main() {
  // La salida es binaria: en modo texto Windows convertiria cada 0x0A en
  // 0x0D 0x0A y destrozaria el audio de forma silenciosa.
  _setmode(_fileno(stdout), _O_BINARY);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    fprintf(stderr, "no se pudo iniciar COM (0x%08lx)\n", hr);
    return 1;
  }

  IMMDeviceEnumerator* enumerator = nullptr;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                        __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));
  if (FAILED(hr)) {
    fprintf(stderr, "no se pudo enumerar los dispositivos (0x%08lx)\n", hr);
    return 1;
  }

  // eRender + eConsole: la salida que Windows usa por defecto para el sonido
  // de los programas, que es exactamente lo que se quiere grabar.
  IMMDevice* device = nullptr;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (FAILED(hr)) {
    fprintf(stderr, "no hay dispositivo de salida predeterminado (0x%08lx)\n", hr);
    return 2;
  }

  IAudioClient* client = nullptr;
  hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                        reinterpret_cast<void**>(&client));
  if (FAILED(hr)) {
    fprintf(stderr, "no se pudo abrir el dispositivo (0x%08lx)\n", hr);
    return 3;
  }

  WAVEFORMATEX* mix = nullptr;
  hr = client->GetMixFormat(&mix);
  if (FAILED(hr)) {
    fprintf(stderr, "no se pudo leer el formato del dispositivo (0x%08lx)\n", hr);
    return 4;
  }

  Format fmt;
  fmt.rate = static_cast<int>(mix->nSamplesPerSec);
  fmt.channels = mix->nChannels;
  fmt.bitsPerSample = mix->wBitsPerSample;
  fmt.isFloat = mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
  fmt.channelMask = 0;
  if (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    WAVEFORMATEXTENSIBLE* ext = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mix);
    fmt.isFloat = ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    fmt.channelMask = ext->dwChannelMask;
  }
  const Downmix downmix = BuildDownmix(fmt);

  // En modo compartido hay que aceptar el formato del sistema tal cual: no se
  // puede pedir otro. La conversion a 48 kHz estereo se hace aqui.
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                          kBufferDuration, 0, mix, nullptr);
  if (FAILED(hr)) {
    fprintf(stderr, "no se pudo iniciar la captura en bucle (0x%08lx)\n", hr);
    return 5;
  }

  IAudioCaptureClient* capture = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture));
  if (FAILED(hr)) {
    fprintf(stderr, "no se pudo obtener el capturador (0x%08lx)\n", hr);
    return 6;
  }

  hr = client->Start();
  if (FAILED(hr)) {
    fprintf(stderr, "no se pudo arrancar la captura (0x%08lx)\n", hr);
    return 7;
  }

  fprintf(stderr, "capturando %d Hz %d canales%s\n", fmt.rate, fmt.channels,
          fmt.isFloat ? " (coma flotante)" : "");
  fflush(stderr);

  // Remuestreo lineal cuando el sistema no va a 48 kHz. Casi siempre lo va,
  // pero algunos equipos usan 44,1 kHz y entregarlo sin convertir haria que el
  // sonido se fuera desplazando respecto a la imagen.
  const double step = static_cast<double>(fmt.rate) / kOutRate;
  double position = 0.0;
  std::vector<short> out;

  while (true) {
    UINT32 packet = 0;
    hr = capture->GetNextPacketSize(&packet);
    if (FAILED(hr)) break;

    if (packet == 0) {
      Sleep(5);
      continue;
    }

    while (packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;

      const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
      out.clear();

      // Se avanza por la senal de origen al ritmo que marca la diferencia de
      // frecuencias, tomando la muestra mas cercana.
      while (position < frames) {
        const int frame = static_cast<int>(position);
        float left = 0.0f;
        float right = 0.0f;
        if (!silent) {
          for (int c = 0; c < fmt.channels; c++) {
            if (downmix.left[c] == 0.0f && downmix.right[c] == 0.0f) continue;
            const float sample = ReadSample(data, fmt, frame, c);
            left += sample * downmix.left[c];
            right += sample * downmix.right[c];
          }
        }
        out.push_back(ToInt16(left));
        out.push_back(ToInt16(right));
        position += step;
      }
      position -= frames;

      if (!out.empty()) {
        if (fwrite(out.data(), sizeof(short), out.size(), stdout) != out.size()) {
          // La tuberia se ha cerrado: Clipper ha dejado de grabar.
          capture->ReleaseBuffer(frames);
          goto done;
        }
        fflush(stdout);
      }

      capture->ReleaseBuffer(frames);
      hr = capture->GetNextPacketSize(&packet);
      if (FAILED(hr)) break;
    }
  }

done:
  client->Stop();
  CoTaskMemFree(mix);
  if (capture) capture->Release();
  if (client) client->Release();
  if (device) device->Release();
  if (enumerator) enumerator->Release();
  CoUninitialize();
  return 0;
}
