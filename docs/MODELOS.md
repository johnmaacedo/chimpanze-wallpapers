# Modelos de IA e licenças

Todos rodam localmente (ONNX Runtime com DirectML na placa de vídeo, ou no processador como reserva). Nenhuma imagem sai do seu computador.

| Uso no app | Modelo | Autor / fonte | Licença |
|---|---|---|---|
| Profundidade | Depth Anything V2 Small (fp16) | Depth Anything / onnx-community (Hugging Face) | Apache-2.0 |
| Recorte de personagens | anime-segmentation ISNet (`isnetis.onnx`) | SkyTNT (Hugging Face `skytnt/anime-seg`) | Apache-2.0 |
| Detecção de rosto de anime | face_detect_v1.4_n (YOLOv8) | deepghs (`deepghs/anime_face_detection`) | MIT |
| Detecção de olhos de anime | eye_detect_v1.0_n (YOLOv8) | deepghs (`deepghs/anime_eye_detection`) | OpenRAIL |
| Borracha, fundo e pálpebras | LaMa (ONNX) | Samsung Research / advimman | Apache-2.0 |
| Upscale | Real-ESRGAN (ncnn-vulkan) e modelos da comunidade | xinntao e autores dos modelos | BSD-3-Clause e licenças dos modelos |

A licença OpenRAIL do detector de olhos permite o uso livre, com restrições apenas para usos danosos. Os textos completos das licenças ficam nas páginas de cada modelo.
