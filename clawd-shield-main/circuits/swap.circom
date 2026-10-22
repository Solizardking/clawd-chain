pragma circom 2.1.0;
// Two-asset private swap. One spent note of assetIn, one output note of
// assetOut, and one change note of assetIn. This is not the single-asset
// transact circuit: inputs and outputs do not share an asset id.
// The revealed spend and amountOut move public reserves. The note key,
// blinding, and unspent remainder stay in the commitments.
// amountOut = floor(reserveOut * spend / (reserveIn + spend)), the same
// integer constant product as chain/market.js outGivenIn.
include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "./merkle.circom";

template PrivateSwap(levels) {
    signal input root;
    signal input nullifier;
    signal input outCommitment;
    signal input changeCommitment;
    signal input assetIn;
    signal input assetOut;
    signal input reserveIn;
    signal input reserveOut;
    signal input spend;
    signal input amountOut;

    signal input amount;
    signal input privateKey;
    signal input blinding;
    signal input pathIndex;
    signal input pathElements[levels];
    signal input outPubkey;
    signal input outBlinding;
    signal input changePubkey;
    signal input changeBlinding;

    component amountBits = Num2Bits(64);
    amountBits.in <== amount;
    component spendBits = Num2Bits(64);
    spendBits.in <== spend;
    component reserveInBits = Num2Bits(64);
    reserveInBits.in <== reserveIn;
    component reserveOutBits = Num2Bits(64);
    reserveOutBits.in <== reserveOut;
    component outBits = Num2Bits(64);
    outBits.in <== amountOut;
    component assetInBits = Num2Bits(64);
    assetInBits.in <== assetIn;
    component assetOutBits = Num2Bits(64);
    assetOutBits.in <== assetOut;

    component spendPos = GreaterThan(64);
    spendPos.in[0] <== spend;
    spendPos.in[1] <== 0;
    spendPos.out === 1;
    component reserveInPos = GreaterThan(64);
    reserveInPos.in[0] <== reserveIn;
    reserveInPos.in[1] <== 0;
    reserveInPos.out === 1;
    component reserveOutPos = GreaterThan(64);
    reserveOutPos.in[0] <== reserveOut;
    reserveOutPos.in[1] <== 0;
    reserveOutPos.out === 1;
    component assetInPos = GreaterThan(64);
    assetInPos.in[0] <== assetIn;
    assetInPos.in[1] <== 0;
    assetInPos.out === 1;
    component assetOutPos = GreaterThan(64);
    assetOutPos.in[0] <== assetOut;
    assetOutPos.in[1] <== 0;
    assetOutPos.out === 1;

    component spendOk = LessEqThan(64);
    spendOk.in[0] <== spend;
    spendOk.in[1] <== amount;
    spendOk.out === 1;

    component distinct = IsEqual();
    distinct.in[0] <== assetIn;
    distinct.in[1] <== assetOut;
    distinct.out === 0;

    signal changeAmount;
    changeAmount <== amount - spend;
    component changeBits = Num2Bits(64);
    changeBits.in <== changeAmount;

    signal denom;
    denom <== reserveIn + spend;
    component denomBits = Num2Bits(65);
    denomBits.in <== denom;

    signal product;
    product <== reserveOut * spend;
    component productBits = Num2Bits(128);
    productBits.in <== product;

    signal lhs;
    lhs <== amountOut * denom;
    component lhsBits = Num2Bits(129);
    lhsBits.in <== lhs;

    // rem = product - amountOut*denom, and 0 <= rem < denom, so amountOut is
    // the integer floor. A wrapped subtraction does not fit in 65 bits.
    signal rem;
    rem <== product - lhs;
    component remBits = Num2Bits(65);
    remBits.in <== rem;
    component remSmall = LessThan(65);
    remSmall.in[0] <== rem;
    remSmall.in[1] <== denom;
    remSmall.out === 1;

    component pub = Poseidon(1);
    pub.inputs[0] <== privateKey;

    component cm = Poseidon(4);
    cm.inputs[0] <== amount;
    cm.inputs[1] <== pub.out;
    cm.inputs[2] <== blinding;
    cm.inputs[3] <== assetIn;

    component sig = Poseidon(3);
    sig.inputs[0] <== privateKey;
    sig.inputs[1] <== cm.out;
    sig.inputs[2] <== pathIndex;

    component nf = Poseidon(3);
    nf.inputs[0] <== cm.out;
    nf.inputs[1] <== pathIndex;
    nf.inputs[2] <== sig.out;
    nf.out === nullifier;

    component tree = MerkleProof(levels);
    tree.leaf <== cm.out;
    tree.pathIndices <== pathIndex;
    for (var i = 0; i < levels; i++) tree.pathElements[i] <== pathElements[i];
    tree.root === root;

    component outCm = Poseidon(4);
    outCm.inputs[0] <== amountOut;
    outCm.inputs[1] <== outPubkey;
    outCm.inputs[2] <== outBlinding;
    outCm.inputs[3] <== assetOut;
    outCm.out === outCommitment;

    component changeCm = Poseidon(4);
    changeCm.inputs[0] <== changeAmount;
    changeCm.inputs[1] <== changePubkey;
    changeCm.inputs[2] <== changeBlinding;
    changeCm.inputs[3] <== assetIn;
    changeCm.out === changeCommitment;
}

component main {public [root, nullifier, outCommitment, changeCommitment, assetIn, assetOut, reserveIn, reserveOut, spend, amountOut]} = PrivateSwap(8);
