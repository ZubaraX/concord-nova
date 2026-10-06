// nova-loopback — screen-share audio for the Windows app.
//
// Electron's "loopback" captures everything the PC plays, including Concord
// Nova itself: everyone in the call heard their own voice come back through
// the stream. Windows 10 2004+ can capture by process instead, so this helper
// streams one of:
//
//   nova-loopback exclude <pid>   all system audio except that process tree
//                                 (screen share: everything but Nova)
//   nova-loopback window <hwnd>   only the process tree owning that window
//                                 (window share: just the game / the player)
//
// to stdout as raw 48 kHz stereo 16-bit PCM. A first line on stderr says
// "ready" (or why it failed). It exits when stdout or stdin closes.
//
// Build (either):
//   clang++ -O2 -std=c++17 -municode -static nova-loopback.cpp -o nova-loopback.exe -lole32 -lmmdevapi -luuid -luser32
//   cl /O2 /EHsc /std:c++17 nova-loopback.cpp ole32.lib mmdevapi.lib user32.lib

#ifndef UNICODE
#define UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <vector>

// From audioclientactivationparams.h (Windows SDK 19041+; not in every SDK or MinGW
// header set, so declared here under our own names).
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
enum NOVA_ACTIVATION_TYPE { NOVA_ACTIVATION_DEFAULT = 0, NOVA_ACTIVATION_PROCESS_LOOPBACK = 1 };
enum NOVA_LOOPBACK_MODE { NOVA_INCLUDE_TREE = 0, NOVA_EXCLUDE_TREE = 1 };
struct NOVA_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  NOVA_LOOPBACK_MODE ProcessLoopbackMode;
};
struct NOVA_ACTIVATION_PARAMS {
  NOVA_ACTIVATION_TYPE ActivationType;
  NOVA_LOOPBACK_PARAMS ProcessLoopbackParams;
};

static void fail(const char* what, HRESULT hr = S_OK) {
  fprintf(stderr, "error %s 0x%08lx\n", what, static_cast<unsigned long>(hr));
  fflush(stderr);
  ExitProcess(1);
}

// ActivateAudioInterfaceAsync reports back through this (it must be agile).
class Completion final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  IAudioClient* client = nullptr;

  STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    } else if (riid == __uuidof(IAgileObject)) {
      *out = static_cast<IAgileObject*>(this);
    } else {
      *out = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs; }
  STDMETHODIMP_(ULONG) Release() override { return --refs; }  // lives on main()'s stack

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT hr = E_FAIL;
    IUnknown* unk = nullptr;
    if (SUCCEEDED(op->GetActivateResult(&hr, &unk)) && SUCCEEDED(hr) && unk) {
      hr = unk->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client));
      unk->Release();
    }
    result = hr;
    SetEvent(done);
    return S_OK;
  }

 private:
  std::atomic<ULONG> refs{1};
};

static std::atomic<bool> running{true};

// The parent closing our stdin (or dying) ends the capture.
static DWORD WINAPI watchStdin(LPVOID) {
  char buf[64];
  DWORD n = 0;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  while (ReadFile(in, buf, sizeof buf, &n, nullptr) && n > 0) {
  }
  running = false;
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: nova-loopback exclude <pid> | window <hwnd>\n");
    return 2;
  }
  DWORD pid = 0;
  NOVA_LOOPBACK_MODE mode = NOVA_EXCLUDE_TREE;
  if (!wcscmp(argv[1], L"exclude") || !wcscmp(argv[1], L"include")) {
    pid = static_cast<DWORD>(wcstoul(argv[2], nullptr, 10));
    mode = !wcscmp(argv[1], L"exclude") ? NOVA_EXCLUDE_TREE : NOVA_INCLUDE_TREE;
  } else if (!wcscmp(argv[1], L"window")) {
    HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(_wcstoui64(argv[2], nullptr, 10)));
    if (!IsWindow(hwnd)) fail("no-window");
    GetWindowThreadProcessId(hwnd, &pid);
    mode = NOVA_INCLUDE_TREE;
  }
  if (!pid) fail("no-process");

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) fail("com", hr);

  NOVA_ACTIVATION_PARAMS params = {};
  params.ActivationType = NOVA_ACTIVATION_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = mode;
  PROPVARIANT var = {};
  var.vt = VT_BLOB;
  var.blob.cbSize = sizeof params;
  var.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  Completion completion;
  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &var, &completion, &op);
  if (FAILED(hr)) fail("activate", hr);  // Windows older than 10 2004 lands here
  WaitForSingleObject(completion.done, 10000);
  if (op) op->Release();
  if (FAILED(completion.result) || !completion.client) fail("activate-result", completion.result);
  IAudioClient* client = completion.client;

  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = 2;
  fmt.nSamplesPerSec = 48000;
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 200000, 0, &fmt, nullptr);
  if (FAILED(hr)) fail("initialize", hr);
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(ready);
  if (FAILED(hr)) fail("event", hr);
  IAudioCaptureClient* capture = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture));
  if (FAILED(hr)) fail("service", hr);
  hr = client->Start();
  if (FAILED(hr)) fail("start", hr);

  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  CreateThread(nullptr, 0, watchStdin, nullptr, 0, nullptr);
  fprintf(stderr, "ready 48000 2 16\n");
  fflush(stderr);

  std::vector<BYTE> silence;
  while (running) {
    WaitForSingleObject(ready, 100);
    UINT32 packet = 0;
    while (running && SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      const DWORD bytes = frames * fmt.nBlockAlign;
      const BYTE* chunk = data;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        silence.assign(bytes, 0);
        chunk = silence.data();
      }
      DWORD written = 0;
      const BOOL ok = bytes == 0 || WriteFile(out, chunk, bytes, &written, nullptr);
      capture->ReleaseBuffer(frames);
      if (!ok) running = false;  // the app went away
    }
  }
  client->Stop();
  capture->Release();
  client->Release();
  CoUninitialize();
  return 0;
}
