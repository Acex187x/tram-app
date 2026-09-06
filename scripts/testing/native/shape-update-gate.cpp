// Exercises the exact production gate independently of React view lookup.
#include "RNMBXShapeUpdateGate.h"
#include <cassert>
#include <iostream>
int main() {
  rnmbx::ShapeUpdateGate gate;
  const auto delayed = gate.begin(10);
  const auto newest = gate.begin(10);
  assert(gate.consume(10, newest)); // New lookup succeeds immediately.
  assert(!gate.consume(10, delayed)); // Older resolver wakes after it: no rewind.
  assert(gate.size() == 0);
  const auto a = gate.begin(10), b = gate.begin(20);
  assert(gate.consume(10, a)); assert(gate.consume(20, b));
  const auto old = gate.begin(10), failed = gate.begin(10);
  assert(gate.consume(10, failed)); // Latest resolver rejects and cleans up.
  assert(!gate.consume(10, old)); // Rejecting latest must not revive stale data.
  for (int i = 0; i < 10000; i++) {
    const auto one = gate.begin(i), two = gate.begin(i);
    assert(!gate.consume(i, one)); assert(gate.consume(i, two));
  }
  assert(gate.size() == 0);
  std::cout << "production ShapeUpdateGate: reorder, failure, isolation and bounded cleanup PASS\n";
}
