DeepFilterNet3 noise suppression, shipped with the app so nothing is fetched
from third-party servers at run time.

DeepFilterNet3.bin  the official model, DeepFilterNet3_onnx.tar.gz from
                    https://github.com/Rikorose/DeepFilterNet (models/).
                    sha256 c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616
                    (a neutral extension: web servers like to add
                    Content-Encoding to *.gz and hand the browser other bytes)
df_bg.wasm          libDF (DeepFilterNet's runtime) built for WebAssembly, as
                    distributed with the deepfilternet3-noise-filter package.
                    sha256 440b5d12b6ea7d95008736f844221d7874ee15de5cb10d3015002470fdba0432

DeepFilterNet is dual-licensed MIT / Apache-2.0 (c) Hendrik Schröter.
