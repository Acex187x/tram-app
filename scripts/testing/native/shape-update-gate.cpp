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
  // A decoded frame must lose to a newer accepted request even when the new
  // request is still waiting for its native view lookup.
  const auto decoded = gate.begin(30);
  assert(gate.isCurrent(30, decoded));
  const auto pendingLookup = gate.begin(30);
  assert(!gate.consume(30, decoded));
  assert(gate.isCurrent(30, pendingLookup));
  assert(gate.consume(30, pendingLookup));

  // Old delayed lookup arrives while the newer frame is decoding. It must
  // never enter Swift/increment the view generation and cancel that newer frame.
  const auto lateLookup = gate.begin(40);
  const auto decoding = gate.begin(40);
  int generation = 0;
  if (gate.isCurrent(40, decoding)) ++generation;
  const auto decodingGeneration = generation;
  if (gate.isCurrent(40, lateLookup)) ++generation;
  assert(generation == decodingGeneration);
  assert(gate.consume(40, decoding));
  assert(!gate.consume(40, lateLookup));
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
  std::cout << "production ShapeUpdateGate: reorder, async decode, late lookup, failure, isolation and bounded cleanup PASS\n";
}
