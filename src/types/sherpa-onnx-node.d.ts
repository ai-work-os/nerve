// Ambient declaration for sherpa-onnx-node, which ships as JS without .d.ts.
// We treat the module as untyped at the boundary; the AsrPipeline wraps it
// with our own VadAdapter / RecognizerAdapter interfaces.
declare module "sherpa-onnx-node";
