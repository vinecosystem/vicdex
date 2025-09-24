// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address a) external view returns (uint256);
    function transfer(address to, uint256 amt) external returns (bool);
    function allowance(address o, address s) external view returns (uint256);
    function approve(address s, uint256 amt) external returns (bool);
    function transferFrom(address f, address t, uint256 amt) external returns (bool);
    function decimals() external view returns (uint8);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
}

abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status = _NOT_ENTERED;

    modifier nonReentrant() {
        require(_status != _ENTERED, "REENTRANCY");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

/// @title VicPool — Constant product AMM (x*y=k) for VIC (native) ↔ VRC25 token
/// @notice LPs receive 100% of swap fees via price impact
contract VicPool is ReentrancyGuard {
    // ---- Configuration ----
    address public immutable factory;
    IERC20  public immutable token;
    uint16  public immutable feeBps;           // e.g. 30 = 0.30%
    uint16  public constant FEE_DEN = 1000;    // denominator for fee bps

    // ---- LP token (minimal ERC20) ----
    string public name;        // "VicPool-LP: VIC-<SYM>"
    string public symbol;      // "VLP-<SYM>"
    uint8  public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    // ---- Reserves ----
    uint256 public reserveVIC;     // native coin (VIC)
    uint256 public reserveToken;   // ERC20/VRC25 token

    // ---- AMM events ----
    event Mint(address indexed sender, uint256 vicIn, uint256 tokenIn, uint256 liquidity);
    event Burn(address indexed sender, uint256 vicOut, uint256 tokenOut, address indexed to);
    event Swap(address indexed sender, uint256 vicIn, uint256 tokenIn, uint256 vicOut, uint256 tokenOut, address indexed to);

    // ---- Custom errors (optional) ----
    error InsufficientLiquidity();
    error InsufficientOutput();
    error InsufficientInput();

    /// @param _token The ERC20/VRC25 token paired against VIC
    /// @param _feeBps Swap fee in basis points (10–100 bps → 0.10%–1.00%)
    constructor(IERC20 _token, uint16 _feeBps) {
        require(_feeBps >= 10 && _feeBps <= 100, "FEE_RANGE"); // 0.10% - 1.00%
        factory = msg.sender;
        token = _token;
        feeBps = _feeBps;

        string memory sym;
        try _token.symbol() returns (string memory s) { sym = s; } catch { sym = "TOKEN"; }
        name   = string(abi.encodePacked("VicPool-LP: VIC-", sym));
        symbol = string(abi.encodePacked("VLP-", sym));
    }

    // ---- ERC20 (LP) ----
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "ALLOWANCE");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "LP_BAL");
        balanceOf[from] -= value;
        balanceOf[to]   += value;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) internal {
        require(balanceOf[from] >= value, "LP_BAL");
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    // ---- Helpers ----
    receive() external payable {}

    function getReserves() external view returns (uint256 vic, uint256 tok) {
        return (reserveVIC, reserveToken);
    }

    function _update(uint256 newVic, uint256 newTok) private {
        reserveVIC = newVic;
        reserveToken = newTok;
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    // ---- Add liquidity ----
    /// @notice Add VIC and token to the pool and receive LP tokens
    /// @param tokenDesired Maximum token amount to transfer in (must approve beforehand)
    /// @param minToken Minimum accepted token amount (slippage protection)
    /// @param minVIC Minimum accepted VIC amount (slippage protection)
    /// @return liquidity LP tokens minted to the caller
    /// @return tokenIn Actual token amount deposited
    /// @return vicIn Actual VIC amount deposited
    function addLiquidity(
        uint256 tokenDesired,
        uint256 minToken,
        uint256 minVIC
    )
        external
        payable
        nonReentrant
        returns (uint256 liquidity, uint256 tokenIn, uint256 vicIn)
    {
        vicIn = msg.value;

        uint256 beforeTok = token.balanceOf(address(this));
        if (tokenDesired > 0) {
            require(token.transferFrom(msg.sender, address(this), tokenDesired), "TRANSFER_FAIL");
        }
        tokenIn = token.balanceOf(address(this)) - beforeTok;

        if (totalSupply == 0) {
            require(vicIn >= minVIC && tokenIn >= minToken, "SLIPPAGE");
            liquidity = _sqrt(vicIn * tokenIn);
            require(liquidity > 0, "LIQ_MINT_0");
            _mint(msg.sender, liquidity);
            _update(vicIn, tokenIn);
            emit Mint(msg.sender, vicIn, tokenIn, liquidity);
            return (liquidity, tokenIn, vicIn);
        }

        require(reserveVIC > 0 && reserveToken > 0, "NO_RESERVES");

        // Keep current price ratio by adjusting the larger-side deposit and refunding the excess
        uint256 requiredTok = (vicIn * reserveToken) / reserveVIC;
        if (tokenIn > requiredTok) {
            // Refund surplus tokens
            uint256 refundTok = tokenIn - requiredTok;
            require(token.transfer(msg.sender, refundTok), "REFUND_TOKEN");
            tokenIn = requiredTok;
        } else if (tokenIn < requiredTok) {
            // Refund surplus VIC (if any)
            uint256 requiredVic = (tokenIn * reserveVIC) / reserveToken;
            require(requiredVic <= vicIn, "VIC_NEED");
            uint256 refundVic = vicIn - requiredVic;
            if (refundVic > 0) {
                (bool ok,) = msg.sender.call{value: refundVic}("");
                require(ok, "REFUND_VIC");
            }
            vicIn = requiredVic;
        }

        require(vicIn >= minVIC && tokenIn >= minToken, "SLIPPAGE");

        liquidity = (vicIn * totalSupply) / reserveVIC;
        require(liquidity > 0, "LIQ_MINT_0");

        _mint(msg.sender, liquidity);
        _update(reserveVIC + vicIn, reserveToken + tokenIn);
        emit Mint(msg.sender, vicIn, tokenIn, liquidity);
    }

    // ---- Remove liquidity ----
    /// @notice Burn LP tokens and receive proportional amounts of VIC and token
    /// @param liquidity Amount of LP tokens to burn
    /// @param minTokenOut Minimum token amount to receive (slippage protection)
    /// @param minVICOut Minimum VIC amount to receive (slippage protection)
    /// @return vicOut VIC sent to the caller
    /// @return tokenOut Token sent to the caller
    function removeLiquidity(
        uint256 liquidity,
        uint256 minTokenOut,
        uint256 minVICOut
    )
        external
        nonReentrant
        returns (uint256 vicOut, uint256 tokenOut)
    {
        require(liquidity > 0, "ZERO_LP");
        uint256 _total = totalSupply;
        require(_total > 0, "NO_LP");

        vicOut   = (liquidity * reserveVIC) / _total;
        tokenOut = (liquidity * reserveToken) / _total;
        require(vicOut >= minVICOut && tokenOut >= minTokenOut, "SLIPPAGE");

        _burn(msg.sender, liquidity);
        _update(reserveVIC - vicOut, reserveToken - tokenOut);

        (bool ok,) = msg.sender.call{value: vicOut}("");
        require(ok, "VIC_SEND");
        require(token.transfer(msg.sender, tokenOut), "TOK_SEND");

        emit Burn(msg.sender, vicOut, tokenOut, msg.sender);
    }

    // ---- Swaps ----
    /// @notice Output amount for a constant product swap with fee applied to the input
    /// @param amountIn Amount being swapped in
    /// @param reserveIn Input-side reserve
    /// @param reserveOut Output-side reserve
    /// @return amountOut Calculated output amount
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    )
        public
        view
        returns (uint256 amountOut)
    {
        require(amountIn > 0 && reserveIn > 0 && reserveOut > 0, "BAD_K");
        uint256 amountInWithFee = amountIn * (FEE_DEN - feeBps) / FEE_DEN;
        amountOut = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
    }

    /// @notice Swap exact VIC for as many tokens as possible
    /// @param minTokensOut Minimum token amount expected (slippage protection)
    /// @param to Recipient of the tokens
    /// @return tokensOut Actual token amount received
    function swapExactVICForTokens(
        uint256 minTokensOut,
        address to
    )
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        uint256 vicIn = msg.value;
        require(vicIn > 0, "NO_VIC");

        tokensOut = getAmountOut(vicIn, reserveVIC, reserveToken);
        require(tokensOut >= minTokensOut, "INSUFFICIENT_OUT");

        _update(reserveVIC + vicIn, reserveToken - tokensOut);
        require(token.transfer(to, tokensOut), "TOK_SEND");

        emit Swap(msg.sender, vicIn, 0, 0, tokensOut, to);
    }

    /// @notice Swap exact tokens for as much VIC as possible
    /// @param tokenIn Exact token amount to send (must approve beforehand)
    /// @param minVICOut Minimum VIC expected (slippage protection)
    /// @param to Recipient of VIC
    /// @return vicOut Actual VIC amount received
    function swapExactTokensForVIC(
        uint256 tokenIn,
        uint256 minVICOut,
        address to
    )
        external
        nonReentrant
        returns (uint256 vicOut)
    {
        require(tokenIn > 0, "NO_TOKEN");

        uint256 beforeBal = token.balanceOf(address(this));
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TRANSFER_FAIL");
        uint256 actualIn = token.balanceOf(address(this)) - beforeBal;

        vicOut = getAmountOut(actualIn, reserveToken, reserveVIC);
        require(vicOut >= minVICOut, "INSUFFICIENT_OUT");

        _update(reserveVIC - vicOut, reserveToken + actualIn);

        (bool ok,) = to.call{value: vicOut}("");
        require(ok, "VIC_SEND");

        emit Swap(msg.sender, 0, actualIn, vicOut, 0, to);
    }
}

/// @title VicPoolFactory — deploys one pool per VRC25 token
contract VicPoolFactory {
    event PoolCreated(address indexed token, address pool, uint16 feeBps);

    mapping(address => address) public getPool;
    address[] public allPools;

    /// @notice Deploy a new pool for a given token
    /// @param token The ERC20/VRC25 token to pair with VIC
    /// @param feeBps Swap fee in basis points (10–100 bps)
    /// @return pool The deployed pool address
    function createPool(IERC20 token, uint16 feeBps) external returns (address pool) {
        require(getPool[address(token)] == address(0), "POOL_EXISTS");
        require(feeBps >= 10 && feeBps <= 100, "FEE_RANGE"); // 0.10% - 1.00%

        pool = address(new VicPool(token, feeBps));
        getPool[address(token)] = pool;
        allPools.push(pool);

        emit PoolCreated(address(token), pool, feeBps);
    }

    /// @return The number of pools created
    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }
}
