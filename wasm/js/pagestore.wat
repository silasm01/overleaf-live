;; pagestore: compares and copies 64 KiB pages between the engine's memory
;; ($eng, imported) and the snapshot page store ($store), with SIMD.
(module
  (import "env" "eng" (memory $eng 1))
  (memory $store (export "store") 1)

  ;; 1 if engine page e and store page s have the same bytes
  (func (export "eq") (param $e i32) (param $s i32) (result i32)
    (local $a i32) (local $b i32) (local $end i32)
    (local.set $a (i32.shl (local.get $e) (i32.const 16)))
    (local.set $b (i32.shl (local.get $s) (i32.const 16)))
    (local.set $end (i32.add (local.get $a) (i32.const 65536)))
    (loop $l
      (if (v128.any_true
            (v128.or
              (v128.or
                (v128.xor (v128.load $eng (local.get $a)) (v128.load $store (local.get $b)))
                (v128.xor (v128.load $eng offset=16 (local.get $a)) (v128.load $store offset=16 (local.get $b))))
              (v128.or
                (v128.xor (v128.load $eng offset=32 (local.get $a)) (v128.load $store offset=32 (local.get $b)))
                (v128.xor (v128.load $eng offset=48 (local.get $a)) (v128.load $store offset=48 (local.get $b))))))
        (then (return (i32.const 0))))
      (local.set $a (i32.add (local.get $a) (i32.const 64)))
      (local.set $b (i32.add (local.get $b) (i32.const 64)))
      (br_if $l (i32.lt_u (local.get $a) (local.get $end))))
    (i32.const 1))

  ;; 1 if engine page e is all zero
  (func (export "zero") (param $e i32) (result i32)
    (local $a i32) (local $end i32)
    (local.set $a (i32.shl (local.get $e) (i32.const 16)))
    (local.set $end (i32.add (local.get $a) (i32.const 65536)))
    (loop $l
      (if (v128.any_true
            (v128.or
              (v128.or (v128.load $eng (local.get $a)) (v128.load $eng offset=16 (local.get $a)))
              (v128.or (v128.load $eng offset=32 (local.get $a)) (v128.load $eng offset=48 (local.get $a)))))
        (then (return (i32.const 0))))
      (local.set $a (i32.add (local.get $a) (i32.const 64)))
      (br_if $l (i32.lt_u (local.get $a) (local.get $end))))
    (i32.const 1))

  ;; engine page e -> store page s
  (func (export "save") (param $e i32) (param $s i32)
    (memory.copy $store $eng (i32.shl (local.get $s) (i32.const 16)) (i32.shl (local.get $e) (i32.const 16)) (i32.const 65536)))

  ;; store page s -> engine page e
  (func (export "load") (param $s i32) (param $e i32)
    (memory.copy $eng $store (i32.shl (local.get $e) (i32.const 16)) (i32.shl (local.get $s) (i32.const 16)) (i32.const 65536)))
)
