pragma circom 2.1.0;
// clawd shield transaction circuit (UTXO model, 2 inputs / 2 outputs).
// note commitment = Poseidon(amount, pubKey, blinding, assetId)
// pubKey          = Poseidon(privKey)
// signature       = Poseidon(privKey, commitment, pathIndex)
// nullifier       = Poseidon(commitment, pathIndex, signature)
// Balance: sum(inAmount) + publicAmount == sum(outAmount)   (publicAmount = extAmount - fee mod p)
include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "./merkle.circom";

template Transact(levels, nIns, nOuts) {
    // public
    signal input root;
    signal input publicAmount;
    signal input extDataHash;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];
    signal input assetId;
    // private
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    component inKey[nIns]; component inCm[nIns]; component inSig[nIns]; component inNf[nIns];
    component inTree[nIns]; component inCheck[nIns]; component inRange[nIns];
    var sumIns = 0;
    for (var i = 0; i < nIns; i++) {
        inKey[i] = Poseidon(1);
        inKey[i].inputs[0] <== inPrivateKey[i];

        inCm[i] = Poseidon(4);
        inCm[i].inputs[0] <== inAmount[i];
        inCm[i].inputs[1] <== inKey[i].out;
        inCm[i].inputs[2] <== inBlinding[i];
        inCm[i].inputs[3] <== assetId;

        inSig[i] = Poseidon(3);
        inSig[i].inputs[0] <== inPrivateKey[i];
        inSig[i].inputs[1] <== inCm[i].out;
        inSig[i].inputs[2] <== inPathIndices[i];

        inNf[i] = Poseidon(3);
        inNf[i].inputs[0] <== inCm[i].out;
        inNf[i].inputs[1] <== inPathIndices[i];
        inNf[i].inputs[2] <== inSig[i].out;
        inNf[i].out === inputNullifier[i];

        inTree[i] = MerkleProof(levels);
        inTree[i].leaf <== inCm[i].out;
        inTree[i].pathIndices <== inPathIndices[i];
        for (var j = 0; j < levels; j++) inTree[i].pathElements[j] <== inPathElements[i][j];

        // membership only enforced for non-zero inputs (dummy zero notes allowed)
        inCheck[i] = ForceEqualIfEnabled();
        inCheck[i].in[0] <== root;
        inCheck[i].in[1] <== inTree[i].root;
        inCheck[i].enabled <== inAmount[i];

        inRange[i] = Num2Bits(64);
        inRange[i].in <== inAmount[i];
        sumIns += inAmount[i];
    }

    component outCm[nOuts]; component outRange[nOuts];
    var sumOuts = 0;
    for (var i = 0; i < nOuts; i++) {
        outCm[i] = Poseidon(4);
        outCm[i].inputs[0] <== outAmount[i];
        outCm[i].inputs[1] <== outPubkey[i];
        outCm[i].inputs[2] <== outBlinding[i];
        outCm[i].inputs[3] <== assetId;
        outCm[i].out === outputCommitment[i];
        outRange[i] = Num2Bits(64);
        outRange[i].in <== outAmount[i];
        sumOuts += outAmount[i];
    }

    // nullifiers distinct
    component same[nIns * (nIns - 1) / 2];
    var k = 0;
    for (var i = 0; i < nIns - 1; i++) for (var j = i + 1; j < nIns; j++) {
        same[k] = IsEqual();
        same[k].in[0] <== inputNullifier[i];
        same[k].in[1] <== inputNullifier[j];
        same[k].out === 0;
        k++;
    }

    // value conservation (64-bit ranges prevent wraparound)
    sumIns + publicAmount === sumOuts;

    // bind extDataHash and assetId into the proof
    signal extSq;
    extSq <== extDataHash * extDataHash;
    signal assetSq;
    assetSq <== assetId * assetId;
}

component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment, assetId]} = Transact(20, 2, 2);
