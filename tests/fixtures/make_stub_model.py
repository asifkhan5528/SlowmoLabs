"""Builds a tiny ONNX model with the same I/O contract as rife49.onnx (img0, img1, timestep -> output),
but computes a plain linear blend. Lets the browser test run the real pipeline without the 20 MB model."""
import onnx
from onnx import helper, TensorProto as T

img0 = helper.make_tensor_value_info('img0', T.FLOAT, [1, 3, 'h', 'w'])
img1 = helper.make_tensor_value_info('img1', T.FLOAT, [1, 3, 'h', 'w'])
ts = helper.make_tensor_value_info('timestep', T.FLOAT, [1])
out = helper.make_tensor_value_info('output', T.FLOAT, [1, 3, 'h', 'w'])
one = helper.make_tensor('one', T.FLOAT, [1], [1.0])
nodes = [
    helper.make_node('Sub', ['one', 'timestep'], ['inv']),
    helper.make_node('Mul', ['img0', 'inv'], ['a']),
    helper.make_node('Mul', ['img1', 'timestep'], ['b']),
    helper.make_node('Add', ['a', 'b'], ['output']),
]
g = helper.make_graph(nodes, 'blend', [img0, img1, ts], [out], initializer=[one])
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 13)])
m.ir_version = 8
onnx.checker.check_model(m)
onnx.save(m, 'tests/fixtures/stub_rife.onnx')
print('saved', len(m.SerializeToString()), 'bytes')
