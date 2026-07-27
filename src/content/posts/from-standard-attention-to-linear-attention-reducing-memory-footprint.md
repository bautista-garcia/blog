---
title: From Standard Attention to Linear Attention Reducing memory footprint
date: 2026-06-05
tags: []
draft: false
---
## Standard Attention
In a standard decode step, we have an input vector $x$ of shape $(\text{hidden\_dim})$ and project it to three vectors: $k_t, q_t, v_t$ of shape $(\text{head\_dim} \times n_{\text{heads}})$. Here, $Q$ is the current token query and $K, V$ represent the historical context for all tokens in the sequence ("past and present"). Each time we project $x$ into $k_t$ and $v_t$, we store it in a KV cache so we don't have to recompute these projections on subsequent decode iterations and compute attention for current token generation:

$$\text{Attention}(Q, K, V) = \text{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right)V$$

This type of attention allows for full context sharing between tokens that are very far apart, at a cost of increasing memory just for storing this cache. In Llama 2 (one of the last models with a multi-head attention architecture), a max context window of 4k tokens occupied about 3.12 GiB of VRAM just for the cache. For comparison, modern models like DeepSeek V4 support up to 1 Million tokens.

$$\text{Memory} = 2 \times \text{layers} \times \text{hidden\_dim} \times \text{bytes (FP16 = 2)} \times \text{max\_context} \approx 3.12 \text{ GiB}$$

Many architectural improvements have scaled down this memory footprint. One was GQA (Grouped-Query Attention), where instead of maintaining $n_{\text{query\_heads}} = n_{\text{key\_heads}} = n_{\text{value\_heads}}$, groups of query heads can share a single underlying KV head, reducing the cache footprint by a factor of $\frac{n_{\text{query\_heads}}}{n_{\text{kv\_heads}}}$. There are also sequence compression tricks (like DeepSeek V4's hybrid layers), but a new paradigm has gained traction in recent models like the Qwen 3.5 family: **Linear Attention** (you can see it as a GatedDeltaNet layer).

## Linear Attention

Linear attention still enables tokens to exchange information, but it drops the compute and memory footprint to $\mathcal{O}(N)$. By removing the softmax step, we can apply the associative property of matrix multiplication. Instead of a growing sequence allocation (of max context), we compress history into a static state matrix (known as similarity matrix), $S = K^T V$. This acts as a "collapsed KV cache" updated once per token, removing the need for each query to explicitly attend to all previous $N$ tokens, shifting complexity from $\mathcal{O}(N^2)$ down to $\mathcal{O}(N)$.

$$\text{Attention}_{\text{GDN}} = \phi(Q) \left( \phi(K)^T V \right)$$

This $S$ matrix of shape $(d_k, d_v)$ holds all key-value relationships within a fixed-size footprint. It acts as an associative memory table, where we can query it by computing $\hat{v} = S^T k$ to see what value it associates with a given key vector. In early linear attention implementations, this matrix was built up as a simple running summation of outer products: $\sum v_i k_i^T$.

However, a more precise way to update this state is to apply the delta rule, as implemented in the **GatedDeltaNet** blocks of the Qwen 3.5 family. The delta update generates a prediction first, then applies a hardware correction matrix based on the error vector, exactly like early perceptrons:

$$\hat{v}_1 = S_0^T k_1 = \begin{pmatrix} 2 & 1 \\ 0 & 2 \end{pmatrix} \begin{pmatrix} 0.8 \\ 0.6 \end{pmatrix} = \begin{pmatrix} 2(0.8) + 1(0.6) \\ 0(0.8) + 2(0.6) \end{pmatrix} = \begin{pmatrix} 2.2 \\ 1.2 \end{pmatrix}$$

We then compute and add the delta correction matrix $\Delta S^T = e_1 k_1^T = (v_1 - \hat{v}_1) k_1^T$ to $S^T$. This yields an updated version of the memory state that actively accounts for the token at $t=1$. This correction ensures that querying the system with that same key immediately afterward forces the output closer to the true expected target $v_1$.

Geometrically, this operation commands the matrix: _"When I query with a key close to $k_i = (x_0, x_1)$, return $v_i = (y_0, y_1)$."_ The core bottleneck with this approach is that if a subsequent token arrives at step $j$ with a highly similar key $k_j = (x_0 + \delta, x_1 + \delta)$ but mapped to a completely different value $v_j = (y_2, y_3)$, the delta update will overwrite the historical trace to favor the new value.

## Conclusion

This extreme memory efficiency comes at the cost of **overwriting long-term dependencies**. To mitigate this, Qwen 3.5 uses a hybrid 3:1 layer ratio: for every 3 Linear Attention layers, 1 standard GQA layer is interleaved to preserve exact, long-range token relationships. Additionally, a local causal convolution is applied right before entering the linear attention block. This blends adjacent tokens together and embeds local context directly into the keys, yielding distinct representations like $k_{\text{good} \mid \text{preceded by "not"}}$ vs. $k_{\text{good} \mid \text{preceded by a comma}}$. Because their geometric layouts no longer overlap exactly, the model prevents overwriting when adjusting $S_t$.