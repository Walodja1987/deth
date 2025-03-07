// @todo add tests for every collateral token I wish to add from Aave V3
import { expect } from "chai";
import hre, { ethers } from "hardhat";
const { parseUnits, toBeHex } = ethers;
// import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  mine,
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-network-helpers";
import {
  AaveDIVAWrapper,
  IAave,
  IDIVA,
  MockERC20,
  ERC20,
  WToken,
} from "../typechain-types";
import {
  SetupOutput,
  CreateContingentPoolParams,
  AddLiquidityParams,
  RemoveLiquidityParams,
  SetupWithPoolResult,
  SetupWithConfirmedPoolResult,
} from "../constants/types";
import { DIVA_ADDRESS, AAVE_ADDRESS } from "../utils/addresses";
import { getExpiryTime, getLastTimestamp } from "../utils/blocktime";
import {
  getPoolIdFromAaveDIVAWrapperEvent,
  getPoolIdFromDIVAEvent,
} from "../utils/eventUtils";
import { calcFee } from "../utils/diva";

const collateralToken = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // USDC (native): 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
const collateralTokenHolder = "0x4D8336bDa6C11BD2a805C291Ec719BaeDD10AcB9"; // Address known to hold a ton of USDC on Polygon at forking block specified in `hardhat.config.ts` (source: https://polygonscan.com/token/0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359#balances)

const collateralTokenUnsupported = "0xB7b31a6BC18e48888545CE79e83E06003bE70930"; // Token that is not supported on Aave (using APE Coin in these tests)

const divaAddress = DIVA_ADDRESS["polygon"];
const aaveAddress = AAVE_ADDRESS["polygon"];

describe("AaveDIVAWrapper", function () {
  // Test setup function
  async function setup(): Promise<SetupOutput> {
    // Get the Signers
    const [owner, acc2, acc3, dataProvider] = await ethers.getSigners();

    // Impersonate account
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [collateralTokenHolder],
    });

    const impersonatedSigner = await ethers.getSigner(collateralTokenHolder);
    // Now `signer` can be used to send transactions from the impersonated account

    // Create a new contract instance to interact with the collateral token
    const collateralTokenContract: ERC20 = await ethers.getContractAt(
      "ERC20",
      collateralToken,
    );

    // Get the decimals of the collateral token
    const collateralTokenDecimals = Number(
      await collateralTokenContract.decimals(),
    );

    // Generate a dummy token and send it to owner
    const dummyTokenDecimals = 18;
    const dummyTokenContract: MockERC20 = await ethers.deployContract(
      "MockERC20",
      [
        "DummyToken", // name
        "DT", // symbol
        ethers.parseUnits("10000", dummyTokenDecimals), // totalSupply
        owner.address, // recipient
        dummyTokenDecimals, // decimals
        0, // feePct
      ],
    );
    await dummyTokenContract.waitForDeployment();

    // Deploy AaveDIVAWrapper contract
    const aaveDIVAWrapper: AaveDIVAWrapper = await ethers.deployContract(
      "AaveDIVAWrapper",
      [
        divaAddress,
        aaveAddress, // @todo is there a better way depending on fork configuration in hardhat.config.ts?
        owner.address,
      ],
    );
    await aaveDIVAWrapper.waitForDeployment();

    // Connect to DIVA Voucher contract instance
    const diva: IDIVA = await ethers.getContractAt("IDIVA", divaAddress);
    const aave: IAave = await ethers.getContractAt("IAave", aaveAddress);

    // Approve AaveDIVAWrapper contract with impersonatedSigner
    await collateralTokenContract
      .connect(impersonatedSigner)
      .approve(aaveDIVAWrapper.target, ethers.MaxUint256);

    // Approve DIVA contract with impersonatedSigner
    await collateralTokenContract
      .connect(impersonatedSigner)
      .approve(diva.target, ethers.MaxUint256);

    // Default create contingent pool parameters. Can be inherited via the spread operator
    // inside the tests and overridden as needed.
    const createContingentPoolParams: CreateContingentPoolParams = {
      referenceAsset: "BTC/USD",
      expiryTime: await getExpiryTime(60 * 60 * 2),
      floor: parseUnits("100"),
      inflection: parseUnits("150"),
      cap: parseUnits("200"),
      gradient: parseUnits("0.5", collateralTokenDecimals),
      collateralAmount: parseUnits("100", collateralTokenDecimals),
      collateralToken: collateralToken,
      dataProvider: dataProvider.address,
      capacity: ethers.MaxUint256,
      longRecipient: impersonatedSigner.address,
      shortRecipient: impersonatedSigner.address,
      permissionedERC721Token: ethers.ZeroAddress,
    };

    // Fixtures can return anything you consider useful for your tests
    return {
      dummyTokenContract,
      dummyTokenDecimals,
      owner,
      acc2,
      acc3,
      dataProvider,
      impersonatedSigner,
      collateralTokenContract,
      collateralTokenDecimals,
      aaveDIVAWrapper,
      aave,
      diva,
      createContingentPoolParams,
    };
  }

  async function setupWithPool(): Promise<SetupWithPoolResult> {
    // Fetch setup fixture.
    const s: SetupOutput = await loadFixture(setup);

    // Register the collateral token and connect to wToken contract.
    await s.aaveDIVAWrapper
      .connect(s.owner)
      .registerCollateralToken(collateralToken);
    const wTokenAddress: string =
      await s.aaveDIVAWrapper.getWToken(collateralToken);
    const wTokenContract: WToken = await ethers.getContractAt(
      "WToken",
      wTokenAddress,
    );

    // Connect to the aToken contracta associated with the collateral token.
    const aTokenAddress: string =
      await s.aaveDIVAWrapper.getAToken(collateralToken);
    const aTokenContract: ERC20 = await ethers.getContractAt(
      "IERC20",
      aTokenAddress,
    );

    // Fund impersonatedSigner with MATIC to be able to pay for gas.
    await hre.network.provider.send("hardhat_setBalance", [
      s.impersonatedSigner.address,
      toBeHex(parseUnits("10", 18)), // Sending 10 MATIC
    ]);

    // Create a new contingent pool via the AaveDIVAWrapper contract.
    await s.aaveDIVAWrapper
      .connect(s.impersonatedSigner)
      .createContingentPool(s.createContingentPoolParams);

    // Fetch the poolId from the event and fetch pool parameters from DIVA Protocol.
    const poolId: string = await getPoolIdFromAaveDIVAWrapperEvent(
      s.aaveDIVAWrapper,
    );
    const poolParams: IDIVA.PoolStructOutput =
      await s.diva.getPoolParameters(poolId);

    // Connect to the short and long token contracts.
    const shortTokenContract: ERC20 = await ethers.getContractAt(
      "IERC20",
      poolParams.shortToken,
    ); // @todo replace by PositionTokenContract interface?
    const longTokenContract: ERC20 = await ethers.getContractAt(
      "IERC20",
      poolParams.longToken,
    ); // @todo replace by PositionTokenContract interface?

    // Approve the AaveDIVAWrapper contract to transfer the short and long tokens.
    await shortTokenContract
      .connect(s.impersonatedSigner)
      .approve(s.aaveDIVAWrapper.target, ethers.MaxUint256);
    await longTokenContract
      .connect(s.impersonatedSigner)
      .approve(s.aaveDIVAWrapper.target, ethers.MaxUint256);

    // Default parameters for removeLiquidity function.
    const r: RemoveLiquidityParams = {
      poolId: poolId,
      positionTokenAmount: parseUnits("10", s.collateralTokenDecimals),
      recipient: s.impersonatedSigner.address,
    };

    // Default parameters for addLiquidity function.
    const a: AddLiquidityParams = {
      poolId: poolId,
      collateralAmount: parseUnits("10", s.collateralTokenDecimals),
      longRecipient: s.impersonatedSigner.address,
      shortRecipient: s.impersonatedSigner.address,
    };

    // Calculate DIVA fee (claimable after the pool has been confirmed inside DIVA Protocol).
    const feesParams: IDIVA.FeesStructOutput = await s.diva.getFees(
      poolParams.indexFees,
    );
    const protocolFee = calcFee(
      feesParams.protocolFee,
      r.positionTokenAmount,
      s.collateralTokenDecimals,
    );
    const settlementFee = calcFee(
      feesParams.settlementFee,
      r.positionTokenAmount,
      s.collateralTokenDecimals,
    );
    const divaFees = protocolFee + settlementFee;

    // Make some assertion to ensure that the setup satisfies required conditions.
    expect(r.positionTokenAmount).to.be.lt(
      s.createContingentPoolParams.collateralAmount,
    );
    expect(divaFees).to.gt(0);

    return {
      s,
      wTokenContract,
      wTokenAddress,
      aTokenContract,
      aTokenAddress,
      poolId,
      poolParams,
      shortTokenContract,
      longTokenContract,
      r,
      divaFees,
      a,
    };
  }

  async function setupWithConfirmedPool(): Promise<SetupWithConfirmedPoolResult> {
    // Use the existing `setupWithPool` function to set up the initial environment and create a pool.
    const {
      s,
      poolId,
      poolParams,
      longTokenContract,
      shortTokenContract,
      wTokenContract,
      aTokenContract,
      divaFees,
    } = await setupWithPool();

    // Fast forward in time past the pool's expiration.
    const nextBlockTimestamp = Number(poolParams.expiryTime) + 1;
    await mine(nextBlockTimestamp);

    // Set the final reference value to confirm the pool.
    await s.diva
      .connect(s.dataProvider)
      .setFinalReferenceValue(poolId, "1", false); // Assuming '1' is a valid reference value

    // Fetch updated pool parameters to confirm the status.
    const updatedPoolParams = await s.diva.getPoolParameters(poolId);
    expect(updatedPoolParams.statusFinalReferenceValue).to.eq(3); // Confirming the pool status

    // Get long and short token balances of impersonatedSigner.
    const longTokenBalance = await longTokenContract.balanceOf(
      s.impersonatedSigner.address,
    );
    const shortTokenBalance = await shortTokenContract.balanceOf(
      s.impersonatedSigner.address,
    );

    // Get collateral token balance of impersonatedSigner.
    const collateralTokenBalance = await s.collateralTokenContract.balanceOf(
      s.impersonatedSigner.address,
    );

    // Get the wToken supply.
    const wTokenSupply = await wTokenContract.totalSupply();

    // Calculate the long and short token payouts and confirm that at least one of them is positive.
    const expectedLongTokenPayout =
      (updatedPoolParams.payoutLong * longTokenBalance) /
      parseUnits("1", s.collateralTokenDecimals);
    const expectedShortTokenPayout =
      (updatedPoolParams.payoutShort * shortTokenBalance) /
      parseUnits("1", s.collateralTokenDecimals);
    expect(expectedLongTokenPayout + expectedShortTokenPayout).to.be.gt(0);

    // Return the updated setup output including the confirmed pool parameters.
    return {
      s,
      poolId,
      poolParams: updatedPoolParams,
      longTokenContract,
      shortTokenContract,
      longTokenBalance,
      shortTokenBalance,
      collateralTokenBalance,
      wTokenSupply,
      wTokenContract,
      aTokenContract,
      divaFees,
      expectedLongTokenPayout,
      expectedShortTokenPayout,
    };
  }

  before(async function () {
    await mine(); // Workaround so that it uses the forked network. See discussion here: https://github.com/NomicFoundation/edr/issues/447; expected to be fixed in a future hardhat release
  });

  describe("Constructor", async () => {
    let s: SetupOutput;

    beforeEach(async () => {
      // Fetch the setup fixture.
      s = await loadFixture(setup);
    });

    it("Impersonated account should have a deposit token balance of at least 1000", async () => {
      // ---------
      // Assert: Confirm that the balance is greater than 1000.
      // ---------
      const balance = await s.collateralTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      expect(balance).to.be.gt(parseUnits("1000", s.collateralTokenDecimals));
    });

    it("Should initialize parameters at contract deployment", async () => {
      // ---------
      // Assert: Confirm that relevant variables are initialized correctly.
      // ---------
      const contractDetails = await s.aaveDIVAWrapper.getContractDetails();
      expect(contractDetails[0]).to.equal(divaAddress);
      expect(contractDetails[1]).to.equal(aaveAddress);
      expect(contractDetails[2]).to.equal(s.owner.address);
    });

    it("Accrued yield should be zero after contract initialization", async () => {
      // ---------
      // Assert: Confirm that the accrued yield is zero.
      // ---------
      const accruedYield =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYield).to.eq(0);
    });

    // -------------------------------------------
    // Reverts
    // -------------------------------------------

    it("Should revert if DIVA address is zero", async () => {
      await expect(
        ethers.deployContract("AaveDIVAWrapper", [
          ethers.ZeroAddress,
          aaveAddress,
          s.owner.address,
        ]),
      ).to.be.revertedWithCustomError(s.aaveDIVAWrapper, "ZeroAddress");
    });

    it("Should revert if Aave V3 address is zero", async () => {
      await expect(
        ethers.deployContract("AaveDIVAWrapper", [
          divaAddress,
          ethers.ZeroAddress,
          s.owner.address,
        ]),
      ).to.be.revertedWithCustomError(s.aaveDIVAWrapper, "ZeroAddress");
    });

    it("Should revert if owner address is zero", async () => {
      await expect(
        ethers.deployContract("AaveDIVAWrapper", [
          divaAddress,
          aaveAddress,
          ethers.ZeroAddress,
        ]),
      )
        .to.be.revertedWithCustomError(s.aaveDIVAWrapper, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress); // reverts inside openzeppelin's Ownable contract
    });
  });

  describe("getAToken", async () => {
    let s: SetupOutput;

    beforeEach(async () => {
      // Fetch the setup fixture.
      s = await loadFixture(setup);
    });

    it("Should return the same aTokenAddress as in Aave Protocol", async () => {
      // ---------
      // Arrange: Fetch the aToken address associated with the collateral token from the AaveDIVAWrapper contract and Aave Protocol.
      // ---------
      // Fetch setup fixture.

      // Fetch aToken address from the DIVADIVAWrapper contract.
      const aTokenAddressAaveDIVAWrapper =
        await s.aaveDIVAWrapper.getAToken(collateralToken);
      expect(aTokenAddressAaveDIVAWrapper).to.not.eq(ethers.ZeroAddress);

      // Fetch the aToken address from Aave Protocol.
      const aTokenAddressAave = (await s.aave.getReserveData(collateralToken))
        .aTokenAddress;
      expect(aTokenAddressAave).to.not.eq(ethers.ZeroAddress);

      // ---------
      // Assert: Confirm that the aToken addresses are equal.
      // ---------
      expect(aTokenAddressAaveDIVAWrapper).to.eq(aTokenAddressAave);
    });

    it("Should return zero aToken address for an unsupported collateral token", async () => {
      // ---------
      // Act: Fetch the aToken address from the AaveDIVAWrapper contract using the unsupported collateral token.
      // ---------
      const aTokenAddress = await s.aaveDIVAWrapper.getAToken(
        collateralTokenUnsupported,
      );

      // ---------
      // Assert: Confirm that the aToken address is zero.
      // ---------
      expect(aTokenAddress).to.equal(ethers.ZeroAddress);
    });
  });

  describe("registerCollateralToken", async () => {
    let s: SetupOutput;

    beforeEach(async () => {
      // Fetch the setup fixture.
      s = await loadFixture(setup);
    });

    it("Should create the wToken and map its address to the registered collateral token", async () => {
      // ---------
      // Arrange: Confirm that the wToken address for an unregistered collateral token is zero.
      // ---------
      const wTokenAddressAaveDIVAWrapperBefore =
        await s.aaveDIVAWrapper.getWToken(collateralToken);
      expect(wTokenAddressAaveDIVAWrapperBefore).to.eq(ethers.ZeroAddress);

      // ---------
      // Act: Register collateral token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .registerCollateralToken(collateralToken);

      // ---------
      // Assert: Confirm that the wToken was created and associated with the registered collateral token.
      // ---------
      // Confirm that the wToken address is associated with the registered collateral token and no longer zero.
      const wTokenAddressAaveDIVAWrapperAfter =
        await s.aaveDIVAWrapper.getWToken(collateralToken);
      expect(wTokenAddressAaveDIVAWrapperAfter).to.not.eq(ethers.ZeroAddress);

      // Connect to the wToken contract and confirm that its address is associated with the expected collateral token address.
      const wTokenContract = await ethers.getContractAt(
        "WToken",
        wTokenAddressAaveDIVAWrapperAfter,
      );
      const collateralTokenAddressAaveDIVAWrapper =
        await s.aaveDIVAWrapper.getCollateralToken(wTokenContract.target);
      expect(collateralTokenAddressAaveDIVAWrapper).to.eq(collateralToken);
    });

    it("Should correctly set symbol, name, decimals, and owner of the wToken", async () => {
      // ---------
      // Arrange: Register the collateral token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .registerCollateralToken(collateralToken);

      // ---------
      // Act: Retrieve the created wToken address and create a contract instance to interact with.
      // ---------
      const wTokenAddress = await s.aaveDIVAWrapper.getWToken(collateralToken);
      const wTokenContract = await ethers.getContractAt(
        "WToken",
        wTokenAddress,
      );

      // ---------
      // Assert: Check that the symbol, name, decimals, and owner are set correctly.
      // ---------
      const collateralTokenContract = await ethers.getContractAt(
        "ERC20",
        collateralToken,
      );
      const expectedSymbol = "w" + (await collateralTokenContract.symbol());
      const expectedDecimals = await collateralTokenContract.decimals();
      const expectedOwner = s.aaveDIVAWrapper.target;

      expect(await wTokenContract.symbol()).to.equal(expectedSymbol);
      expect(await wTokenContract.name()).to.equal(expectedSymbol);
      expect(await wTokenContract.decimals()).to.equal(expectedDecimals);
      expect(await wTokenContract.owner()).to.equal(expectedOwner);
    });

    it("wToken supply should be zero immediately after registration", async () => {
      // ---------
      // Arrange: Register the collateral token to create and setup the wToken.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .registerCollateralToken(collateralToken);
      const wTokenAddress = await s.aaveDIVAWrapper.getWToken(collateralToken);
      const wTokenContract = await ethers.getContractAt(
        "WToken",
        wTokenAddress,
      );

      // ---------
      // Act: Retrieve the total supply of the wToken.
      // ---------
      const wTokenSupply = await wTokenContract.totalSupply();

      // ---------
      // Assert: Check that the total supply of the wToken is zero.
      // ---------
      expect(wTokenSupply).to.equal(0);
    });

    it("Should set correct allowance for wToken to DIVA contract", async () => {
      // ---------
      // Arrange: Register the collateral token to create and setup the wToken.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .registerCollateralToken(collateralToken);
      const wTokenAddress = await s.aaveDIVAWrapper.getWToken(collateralToken);
      const wTokenContract = await ethers.getContractAt(
        "WToken",
        wTokenAddress,
      );

      // ---------
      // Act: Retrieve the allowance of the wToken for the DIVA contract.
      // ---------
      const wTokenAllowance = await wTokenContract.allowance(
        s.aaveDIVAWrapper.target,
        divaAddress,
      );

      // ---------
      // Assert: Check that the wToken has given unlimited approval to the DIVA contract.
      // ---------
      expect(wTokenAllowance).to.equal(ethers.MaxUint256);
    });

    it("Should set correct allowance for collateral token to Aave V3 contract", async () => {
      // ---------
      // Arrange: Register the collateral token and setup the necessary approvals.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .registerCollateralToken(collateralToken);
      const collateralTokenContract = await ethers.getContractAt(
        "IERC20",
        collateralToken,
      );

      // ---------
      // Act: Retrieve the allowance of the collateral token for the Aave V3 contract.
      // ---------
      const collateralTokenAllowance = await collateralTokenContract.allowance(
        s.aaveDIVAWrapper.target,
        aaveAddress,
      );

      // ---------
      // Assert: Check that the collateral token has given unlimited approval to the Aave V3 contract.
      // ---------
      expect(collateralTokenAllowance).to.equal(ethers.MaxUint256);
    });

    it("Accrued yield should be zero right after registration", async () => {
      // ---------
      // Act: Register collateral token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .registerCollateralToken(collateralToken);

      // ---------
      // Assert: Confirm that the accrued yield is zero shortly after registration and after several blocks.
      // ---------
      const accruedYield =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYield).to.eq(0);
    });

    it("Accrued yield should remain zero after several blocks post-registration (assuming no pools are created)", async () => {
      // ---------
      // Arrange: Register collateral token and mine several blocks.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .registerCollateralToken(collateralToken);
      const nextBlockTimestamp = (await getLastTimestamp()) + 1000; // @todo maybe use const blockNumberBefore = await time.latestBlock();?
      await mine(nextBlockTimestamp);

      // ---------
      // Assert: Confirm that the accrued yield is still zero after several blocks.
      // ---------
      const accruedYieldAfterSeveralBlocks =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYieldAfterSeveralBlocks).to.eq(0);
    });

    // -------------------------------------------
    // Reverts
    // -------------------------------------------

    it("Should revert if trying to register a collateral token that is already registered", async () => {
      // ---------
      // Arrange: Register the collateral token once.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .registerCollateralToken(collateralToken);

      // ---------
      // Act & Assert: Attempt to register the same collateral token again and expect a revert.
      // ---------
      await expect(
        s.aaveDIVAWrapper
          .connect(s.owner)
          .registerCollateralToken(collateralToken),
      ).to.be.revertedWithCustomError(
        s.aaveDIVAWrapper,
        "CollateralTokenAlreadyRegistered",
      );
    });

    it("Should revert if trying to register a collateral token that is not supported", async () => {
      // ---------
      // Act & Assert: Attempt to register the collateral token that is not supported and expect a revert.
      // ---------
      await expect(
        s.aaveDIVAWrapper
          .connect(s.owner)
          .registerCollateralToken(collateralTokenUnsupported),
      ).to.be.revertedWithCustomError(
        s.aaveDIVAWrapper,
        "UnsupportedCollateralToken",
      );
    });

    it("Should revert if trying to register the zero address as collateral", async () => {
      // ---------
      // Act & Assert: Attempt to register the zero address and expect a revert.
      // ---------
      await expect(
        s.aaveDIVAWrapper
          .connect(s.owner)
          .registerCollateralToken(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(
        s.aaveDIVAWrapper,
        "UnsupportedCollateralToken",
      );
    });
  });

  describe("wToken", async () => {
    let s: SetupOutput;
    let wTokenContract: WToken;

    beforeEach(async () => {
      ({ s, wTokenContract } = await setupWithPool()); // @todo test whether the fork is reset to the snapsho if using setupWithPool
    });

    it("Should return the AaveDIVAWrapper contract address as the owner of the wToken", async () => {
      expect(await wTokenContract.owner()).to.eq(s.aaveDIVAWrapper.target);
    });

    // -------------------------------------------
    // Reverts
    // -------------------------------------------

    it("Should revert if AaveDIVAWrapper owner tries to mint wToken", async () => {
      // ---------
      // Act & Assert: Attempt to mint wToken with the owner of the AaveDIVAWrapper contract and expect it to revert.
      // ---------
      const amountToMint = parseUnits("1", s.collateralTokenDecimals);
      await expect(
        wTokenContract.connect(s.owner).mint(s.owner.address, amountToMint),
      ).to.be.revertedWith("CollateralToken: caller is not owner");
    });

    it("Should revert if any other non-owner account tries to mint wToken", async () => {
      // ---------
      // Act & Assert: Attempt to mint wToken with acc2 and expect it to revert.
      // ---------
      const amountToMint = parseUnits("1", s.collateralTokenDecimals);
      await expect(
        wTokenContract.connect(s.acc2).mint(s.acc2.address, amountToMint),
      ).to.be.revertedWith("CollateralToken: caller is not owner");
    });

    it("Should revert if AaveDIVAWrapper owner tries to burn wToken", async () => {
      // ---------
      // Act & Assert: Attempt to burn wToken with the owner of the AaveDIVAWrapper contract and expect it to revert.
      // ---------
      const amountToBurn = parseUnits("1", s.collateralTokenDecimals);
      await expect(
        wTokenContract.connect(s.owner).burn(s.owner.address, amountToBurn),
      ).to.be.revertedWith("CollateralToken: caller is not owner");
    });

    it("Should revert if any other non-owner account tries to burn wToken", async () => {
      // ---------
      // Act & Assert: Attempt to burn wToken with acc2 and expect it to revert.
      // ---------
      const amountToBurn = parseUnits("1", s.collateralTokenDecimals);
      await expect(
        wTokenContract.connect(s.acc2).burn(s.acc2.address, amountToBurn),
      ).to.be.revertedWith("CollateralToken: caller is not owner");
    });
  });

  describe("createContingentPool", async () => {
    let s: SetupOutput;
    let wTokenContract: WToken;
    let aTokenContract: ERC20;

    beforeEach(async () => {
      ({ s, wTokenContract, aTokenContract } = await setupWithPool());
    });

    it("Should create a contingent pool and correctly initialize the pool parameters", async () => {
      // ---------
      // Act: Create a new contingent pool via the AaveDIVAWrapper contract (not using the one created inside
      // `setupWithPool` function in order to capture the correct block timestamp which is used as `statusTimestamp`
      // in DIVA Protocol's pool parameters).
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // Extract poolId from DIVA Protocol's PoolIssued event and get the pool parameters.
      const poolId = await getPoolIdFromAaveDIVAWrapperEvent(s.aaveDIVAWrapper);
      const poolParams = await s.diva.getPoolParameters(poolId);

      // Get the current block timestamp. Used to check whether `statusTimestamp` in pool parameters is set correctly.
      const currentBlockTimestamp = await getLastTimestamp();

      // ---------
      // Assert: Confirm that the pool parameters in DIVA Protocol were correctly initialized
      // ---------
      expect(poolParams.referenceAsset).to.eq(
        s.createContingentPoolParams.referenceAsset,
      );
      expect(poolParams.expiryTime).to.eq(
        s.createContingentPoolParams.expiryTime,
      );
      expect(poolParams.floor).to.eq(s.createContingentPoolParams.floor);
      expect(poolParams.inflection).to.eq(
        s.createContingentPoolParams.inflection,
      );
      expect(poolParams.cap).to.eq(s.createContingentPoolParams.cap);
      expect(poolParams.collateralToken).to.eq(wTokenContract.target); // Must be wToken here
      expect(poolParams.gradient).to.eq(s.createContingentPoolParams.gradient);
      expect(poolParams.collateralBalance).to.eq(
        s.createContingentPoolParams.collateralAmount,
      );
      expect(poolParams.shortToken).is.properAddress;
      expect(poolParams.longToken).is.properAddress;
      expect(poolParams.finalReferenceValue).to.eq(0);
      expect(poolParams.statusFinalReferenceValue).to.eq(0);
      expect(poolParams.payoutLong).to.eq(0);
      expect(poolParams.payoutShort).to.eq(0);
      expect(poolParams.statusTimestamp).to.eq(currentBlockTimestamp);
      expect(poolParams.dataProvider).to.eq(
        s.createContingentPoolParams.dataProvider,
      );
      expect(poolParams.capacity).to.eq(s.createContingentPoolParams.capacity);
    });

    it("Should increase the long and short token balance of the recipient", async () => {
      // ---------
      // Arrange: Confirm that the long and short token recipient is the impersonated signer (chosen as default in createContingentPoolParams).
      // ---------
      expect(s.createContingentPoolParams.longRecipient).to.eq(
        s.impersonatedSigner,
      );
      expect(s.createContingentPoolParams.shortRecipient).to.eq(
        s.impersonatedSigner,
      );

      // ---------
      // Act: Create a new contingent pool via the AaveDIVAWrapper contract.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // ---
      // Assert: Confirm that the recipient's long and short token balances increases by the collateral amount deposited.
      // ---
      // Extract poolId from DIVA Protocol's PoolIssued event and get the pool parameters.
      const poolId = await getPoolIdFromAaveDIVAWrapperEvent(s.aaveDIVAWrapper);
      const poolParams = await s.diva.getPoolParameters(poolId);

      // Connect to the short and long token contracts.
      const shortTokenContract = await ethers.getContractAt(
        "IERC20",
        poolParams.shortToken,
      );
      const longTokenContract = await ethers.getContractAt(
        "IERC20",
        poolParams.longToken,
      );

      // Confirm that the short and long token recipient's position token balance increases by the collateral amount deposited.
      expect(
        await shortTokenContract.balanceOf(s.impersonatedSigner.address),
      ).to.eq(s.createContingentPoolParams.collateralAmount);
      expect(
        await longTokenContract.balanceOf(s.impersonatedSigner.address),
      ).to.eq(s.createContingentPoolParams.collateralAmount);
    });

    it("Should increase the long and short token balance of two different recipients", async () => {
      // ---------
      // Arrange: Overwrite the long and short token recipients in createContingentPoolParams.
      // ---------
      const modifiedCreateContingentPoolParams = {
        ...s.createContingentPoolParams,
        longRecipient: s.acc2.address,
        shortRecipient: s.acc3.address,
      };

      // ---------
      // Act: Create a new contingent pool via the AaveDIVAWrapper contract.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .createContingentPool(modifiedCreateContingentPoolParams);

      // ---
      // Assert: Confirm that the recipients' long and short token balances increase by the collateral amount deposited.
      // ---
      // Extract poolId from DIVA Protocol's PoolIssued event and get the pool parameters.
      const poolId = await getPoolIdFromAaveDIVAWrapperEvent(s.aaveDIVAWrapper);
      const poolParams = await s.diva.getPoolParameters(poolId);

      // Connect to the short and long token contracts.
      const shortTokenContract = await ethers.getContractAt(
        "IERC20",
        poolParams.shortToken,
      );
      const longTokenContract = await ethers.getContractAt(
        "IERC20",
        poolParams.longToken,
      );

      // Confirm that the recipients' long and short token balances increase by the collateral amount deposited.
      expect(await shortTokenContract.balanceOf(s.acc3.address)).to.eq(
        modifiedCreateContingentPoolParams.collateralAmount,
      );
      expect(await longTokenContract.balanceOf(s.acc2.address)).to.eq(
        modifiedCreateContingentPoolParams.collateralAmount,
      );
    });

    it("Should reduce the user's collateral token balance", async () => {
      // ---------
      // Arrange: Get the collateral token balance of the user before creating a new contingent pool.
      // ---------
      const collateralTokenBalanceBefore =
        await s.collateralTokenContract.balanceOf(s.impersonatedSigner.address);

      // ---------
      // Act: Create a new contingent pool via the AaveDIVAWrapper contract.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // ---------
      // Assert: Confirm that the collateral token balance of the user reduced by the collateral amount deposited.
      // ---------
      const collateralTokenBalanceAfter =
        await s.collateralTokenContract.balanceOf(s.impersonatedSigner.address);
      expect(collateralTokenBalanceAfter).to.eq(
        collateralTokenBalanceBefore -
          BigInt(s.createContingentPoolParams.collateralAmount),
      );
    });

    it("Should increase the wToken supply after creating the pool", async () => {
      // ---------
      // Arrange: Get the wToken supply before pool creation.
      // ---------
      const wTokenSupplyBefore = await wTokenContract.totalSupply();

      // ---------
      // Act: Create a new contingent pool via the AaveDIVAWrapper contract.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // ---------
      // Assert: Confirm that the wToken supply increased by the collateral amount deposited.
      // ---------
      const wTokenSupplyAfter = await wTokenContract.totalSupply();
      expect(wTokenSupplyAfter).to.eq(
        wTokenSupplyBefore + s.createContingentPoolParams.collateralAmount,
      );
    });

    it("Should increase DIVA Protocol's wToken balance after creating the pool", async () => {
      // ---------
      // Arrange: Get the wToken balance of DIVA Protocol before pool creation.
      // ---------
      const wTokenBalanceDIVABefore =
        await wTokenContract.balanceOf(divaAddress);

      // ---------
      // Act: Create a new contingent pool via the AaveDIVAWrapper contract.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // ---------
      // Assert: Confirm that DIVA Protocol's wToken balance increased by the collateral amount deposited.
      // ---------
      const wTokenBalanceDIVAAfter =
        await wTokenContract.balanceOf(divaAddress);
      expect(wTokenBalanceDIVAAfter).to.eq(
        wTokenBalanceDIVABefore + s.createContingentPoolParams.collateralAmount,
      );
    });

    it("The AaveDIVAWrapper contract's wToken balance should be zero before and after pool creation", async () => {
      // ---------
      // Arrange: Confirm that the wToken balance of the AaveDIVAWrapper contract before pool creation is zero.
      // ---------
      const wTokenBalanceAaveDIVAWrapperBefore = await wTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(wTokenBalanceAaveDIVAWrapperBefore).to.eq(0);

      // ---------
      // Act: Create a new contingent pool via the AaveDIVAWrapper contract.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // ---------
      // Assert: Confirm that AaveDIVAWrapper contract's wToken balance remains zero after pool creation.
      // ---------
      const wTokenBalanceAaveDIVAWrapperAfter = await wTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(wTokenBalanceAaveDIVAWrapperAfter).to.eq(0);
    });

    it("The AaveDIVAWrapper contract's collateralToken balance should be zero before and after pool creation", async () => {
      // ---------
      // Arrange: Confirm that the collateralToken balance of the AaveDIVAWrapper contract before pool creation is zero.
      // ---------
      const collateralTokenContract = await ethers.getContractAt(
        "IERC20",
        collateralToken,
      );
      const collateralTokenBalanceAaveDIVAWrapperBefore =
        await collateralTokenContract.balanceOf(s.aaveDIVAWrapper.target);
      expect(collateralTokenBalanceAaveDIVAWrapperBefore).to.eq(0);

      // ---------
      // Act: Create a new contingent pool via the AaveDIVAWrapper contract.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // ---------
      // Assert: Confirm that AaveDIVAWrapper contract's collateralToken balance remains zero after pool creation.
      // ---------
      const collateralTokenBalanceAaveDIVAWrapperAfter =
        await collateralTokenContract.balanceOf(s.aaveDIVAWrapper.target);
      expect(collateralTokenBalanceAaveDIVAWrapperAfter).to.eq(0);
    });

    it("Should increase the aToken balance of AaveDIVAWrapper contract after creating the pool", async () => {
      // ---------
      // Arrange: Get the aToken balance of AaveDIVAWrapper contract before pool creation.
      // ---------
      const aTokenBalanceAaveDIVAWrapperBefore = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );

      // ---------
      // Act: Create a new contingent pool via the AaveDIVAWrapper contract.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // ---------
      // Assert: Confirm that the aToken balance of AaveDIVAWrapper contract increased by the collateral amount deposited.
      // ---------
      const aTokenBalanceAaveDIVAWrapperAfter = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(aTokenBalanceAaveDIVAWrapperAfter).to.closeTo(
        aTokenBalanceAaveDIVAWrapperBefore +
          s.createContingentPoolParams.collateralAmount,
        1,
      ); // closeTo to account for yield that might have accrued since last block
    });

    it("Accrued yield should be zero right after first pool creation", async () => {
      // the aToken balance is visible, like here: https://github.com/aave/aave-v3-core/blob/b74526a7bc67a3a117a1963fc871b3eb8cea8435/test-suites/atoken-event-accounting.spec.ts#L74
      // ---------
      // Act: Create a new contingent pool via the AaveDIVAWrapper contract.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // ---------
      // Assert: Confirm that the accrued yield is zero (or at least less than one in case some yield already accrued) after creating the very first pool.
      // ---------
      const accruedYield =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYield).to.be.lte(1);
    });
  });

  describe("addLiquidity", async () => {
    let s: SetupOutput;
    let wTokenContract: WToken;
    let aTokenContract: ERC20;
    let shortTokenContract: ERC20; // @todo replace by PositionTokenContract interface?
    let longTokenContract: ERC20; // @todo replace by PositionTokenContract interface?
    let a: AddLiquidityParams;

    beforeEach(async () => {
      ({
        s,
        wTokenContract,
        aTokenContract,
        shortTokenContract,
        longTokenContract,
        a,
      } = await setupWithPool());
    });

    it("Should increase the long and short token balance of the recipient", async () => {
      // ---------
      // Arrange: Get the initial balances of the long and short token recipients (impersonatedSigner by default).
      // ---------
      const longTokenBalanceBefore = await longTokenContract.balanceOf(
        a.longRecipient,
      );
      const shortTokenBalanceBefore = await shortTokenContract.balanceOf(
        a.shortRecipient,
      );

      // ---------
      // Act: Add liquidity to the existing pool.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .addLiquidity(
          a.poolId,
          a.collateralAmount,
          a.longRecipient,
          a.shortRecipient,
        );

      // ---------
      // Assert: Confirm that the recipient's long and short token balances increased by the collateral amount deposited.
      // ---------
      const longTokenBalanceAfter = await longTokenContract.balanceOf(
        a.longRecipient,
      );
      const shortTokenBalanceAfter = await shortTokenContract.balanceOf(
        a.shortRecipient,
      );
      expect(longTokenBalanceAfter).to.eq(
        longTokenBalanceBefore + a.collateralAmount,
      );
      expect(shortTokenBalanceAfter).to.eq(
        shortTokenBalanceBefore + a.collateralAmount,
      );
    });

    it("Should increase the long and short token balance for two different recipients", async () => {
      // ---------
      // Arrange: Use acc2 and acc3 as long and short token recipients and get their initial position token balances.
      // ---------
      a.longRecipient = s.acc2.address;
      a.shortRecipient = s.acc3.address;
      const longTokenBalanceBefore = await longTokenContract.balanceOf(
        a.longRecipient,
      );
      const shortTokenBalanceBefore = await shortTokenContract.balanceOf(
        a.shortRecipient,
      );

      // ---------
      // Act: Add liquidity to the existing pool.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .addLiquidity(
          a.poolId,
          a.collateralAmount,
          a.longRecipient,
          a.shortRecipient,
        );

      // ---------
      // Assert: Confirm that the recipient's long and short token balances increased by the collateral amount deposited.
      // ---------
      const longTokenBalanceAfter = await longTokenContract.balanceOf(
        a.longRecipient,
      );
      const shortTokenBalanceAfter = await shortTokenContract.balanceOf(
        a.shortRecipient,
      );
      expect(longTokenBalanceAfter).to.eq(
        longTokenBalanceBefore + a.collateralAmount,
      );
      expect(shortTokenBalanceAfter).to.eq(
        shortTokenBalanceBefore + a.collateralAmount,
      );
    });

    it("Should reduce the user's collateral token balance", async () => {
      // ---------
      // Arrange: Get the collateral token balance of the user before adding liquidity.
      // ---------
      const collateralTokenBalanceBefore =
        await s.collateralTokenContract.balanceOf(s.impersonatedSigner.address);

      // ---------
      // Act: Add liquidity to the existing pool.
      // ---------
      await s.aaveDIVAWrapper.connect(s.impersonatedSigner).addLiquidity(
        a.poolId,
        a.collateralAmount,
        a.longRecipient, // impersonatedSigner by default
        a.shortRecipient, // impersonatedSigner by default
      );

      // ---------
      // Assert: Confirm that the collateral token balance of the user reduced by the collateral amount deposited.
      // ---------
      const collateralTokenBalanceAfter =
        await s.collateralTokenContract.balanceOf(s.impersonatedSigner.address);
      expect(collateralTokenBalanceAfter).to.eq(
        collateralTokenBalanceBefore - BigInt(a.collateralAmount),
      );
    });

    it("Should increase the wToken supply after adding liquidity", async () => {
      // ---------
      // Arrange: Get the wToken supply before adding liquidity.
      // ---------
      const wTokenSupplyBefore = await wTokenContract.totalSupply();

      // ---------
      // Act: Add liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .addLiquidity(
          a.poolId,
          a.collateralAmount,
          a.longRecipient,
          a.shortRecipient,
        );

      // ---------
      // Assert: Confirm that the wToken supply increased by the collateral amount deposited.
      // ---------
      const wTokenSupplyAfter = await wTokenContract.totalSupply();
      expect(wTokenSupplyAfter).to.eq(wTokenSupplyBefore + a.collateralAmount);
    });

    it("The AaveDIVAWrapper contract's wToken balance should be zero before and after adding liquidity", async () => {
      // ---------
      // Arrange: Confirm that the wToken balance of the AaveDIVAWrapper contract before adding liquidity is zero.
      // ---------
      const wTokenBalanceAaveDIVAWrapperBefore = await wTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(wTokenBalanceAaveDIVAWrapperBefore).to.eq(0);

      // ---------
      // Act: Add liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .addLiquidity(
          a.poolId,
          a.collateralAmount,
          a.longRecipient,
          a.shortRecipient,
        );

      // ---------
      // Assert: Confirm that AaveDIVAWrapper contract's wToken balance remains zero after adding liquidity.
      // ---------
      const wTokenBalanceAaveDIVAWrapperAfter = await wTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(wTokenBalanceAaveDIVAWrapperAfter).to.eq(0);
    });

    it("The AaveDIVAWrapper contract's collateralToken balance should be zero before and after adding liquidity", async () => {
      // ---------
      // Arrange: Confirm that the collateralToken balance of the AaveDIVAWrapper contract before adding liquidity is zero.
      // ---------
      const collateralTokenContract = await ethers.getContractAt(
        "IERC20",
        collateralToken,
      );
      const collateralTokenBalanceAaveDIVAWrapperBefore =
        await collateralTokenContract.balanceOf(s.aaveDIVAWrapper.target);
      expect(collateralTokenBalanceAaveDIVAWrapperBefore).to.eq(0);

      // ---------
      // Act: Add liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .addLiquidity(
          a.poolId,
          a.collateralAmount,
          a.longRecipient,
          a.shortRecipient,
        );

      // ---------
      // Assert: Confirm that AaveDIVAWrapper contract's collateralToken balance remains zero after adding liquidity.
      // ---------
      const collateralTokenBalanceAaveDIVAWrapperAfter =
        await collateralTokenContract.balanceOf(s.aaveDIVAWrapper.target);
      expect(collateralTokenBalanceAaveDIVAWrapperAfter).to.eq(0);
    });

    it("Should increase the aToken balance of AaveDIVAWrapper contract after adding liquidity", async () => {
      // ---------
      // Arrange: Get the aToken balance of AaveDIVAWrapper contract before adding liquidity.
      // ---------
      const aTokenBalanceAaveDIVAWrapperBefore = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );

      // ---------
      // Act: Add liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .addLiquidity(
          a.poolId,
          a.collateralAmount,
          a.longRecipient,
          a.shortRecipient,
        );

      // ---------
      // Assert: Confirm that the aToken balance of AaveDIVAWrapper contract increased by the collateral amount deposited.
      // ---------
      const aTokenBalanceAaveDIVAWrapperAfter = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(aTokenBalanceAaveDIVAWrapperAfter).to.closeTo(
        aTokenBalanceAaveDIVAWrapperBefore + a.collateralAmount, // closeTo to account for yield that might have accrued since last block
        1,
      );
    });

    it("Should not change the accrued yield", async () => {
      // ---------
      // Arrange: Get the accrued yield before adding liquidity.
      // ---------
      const accruedYieldBefore =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);

      // ---------
      // Act: Add liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .addLiquidity(
          a.poolId,
          a.collateralAmount,
          a.longRecipient,
          a.shortRecipient,
        );

      // ---------
      // Assert: Confirm that the accrued yield remains the same after adding liquidity.
      // ---------
      const accruedYieldAfter =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYieldAfter).to.closeTo(accruedYieldBefore, 1); // closeTo to account for yield that might have accrued since last block
    });
  });

  describe("removeLiquidity", async () => {
    let s: SetupOutput;
    let wTokenContract: WToken;
    let aTokenContract: ERC20;
    let shortTokenContract: ERC20; // @todo replace by PositionTokenContract interface?
    let longTokenContract: ERC20; // @todo replace by PositionTokenContract interface?
    let r: RemoveLiquidityParams;
    let divaFees: bigint;

    beforeEach(async () => {
      ({
        s,
        wTokenContract,
        aTokenContract,
        shortTokenContract,
        longTokenContract,
        r,
        divaFees,
      } = await setupWithPool());
      expect(r.positionTokenAmount).to.be.gt(0);
      expect(r.positionTokenAmount).to.be.lt(
        s.createContingentPoolParams.collateralAmount,
      );
      expect(divaFees).to.gt(0);
    });

    it("Should reduce the long and short token balance of the user", async () => {
      // ---------
      // Arrange: Get the initial balances of the long and short token recipients (impersonatedSigner created the pool inside
      // the beforeEach block and hence owns both tokens).
      // ---------
      const longTokenBalanceBefore = await longTokenContract.balanceOf(
        s.impersonatedSigner,
      );
      const shortTokenBalanceBefore = await shortTokenContract.balanceOf(
        s.impersonatedSigner,
      );

      // ---------
      // Act: Remove liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .removeLiquidity(r.poolId, r.positionTokenAmount, r.recipient);

      // ---------
      // Assert: Confirm that the user's long and short token balances reduced by the position token amount removed.
      // ---------
      const longTokenBalanceAfter = await longTokenContract.balanceOf(
        s.impersonatedSigner,
      );
      const shortTokenBalanceAfter = await shortTokenContract.balanceOf(
        s.impersonatedSigner,
      );
      expect(longTokenBalanceAfter).to.eq(
        longTokenBalanceBefore - BigInt(r.positionTokenAmount),
      );
      expect(shortTokenBalanceAfter).to.eq(
        shortTokenBalanceBefore - BigInt(r.positionTokenAmount),
      );
    });

    it("Should increase the user's collateral token balance", async () => {
      // ---------
      // Arrange: Get the collateral token balance of the user before removing liquidity.
      // ---------
      const collateralTokenBalanceBefore =
        await s.collateralTokenContract.balanceOf(s.impersonatedSigner.address);

      // ---------
      // Act: Remove liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .removeLiquidity(r.poolId, r.positionTokenAmount, r.recipient);

      // ---------
      // Assert: Confirm that the collateral token balance of the user increased by the position token amount removed adjusted for DIVA fee.
      // ---------
      const collateralTokenBalanceAfter =
        await s.collateralTokenContract.balanceOf(s.impersonatedSigner.address);
      expect(collateralTokenBalanceAfter).to.eq(
        collateralTokenBalanceBefore + BigInt(r.positionTokenAmount) - divaFees,
      );
    });

    it("Should reduce the wToken supply after removing liquidity", async () => {
      // ---------
      // Arrange: Get the wToken supply before removing liquidity.
      // ---------
      const wTokenSupplyBefore = await wTokenContract.totalSupply();

      // ---------
      // Act: Remove liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .removeLiquidity(r.poolId, r.positionTokenAmount, r.recipient);

      // ---------
      // Assert: Confirm that the wToken supply reduced by the position token amount removed adjusted for DIVA fee.
      // ---------
      const wTokenSupplyAfter = await wTokenContract.totalSupply();
      expect(wTokenSupplyAfter).to.eq(
        wTokenSupplyBefore - BigInt(r.positionTokenAmount) + divaFees,
      );
    });

    it("The AaveDIVAWrapper contract's wToken balance should be zero before and after removing liquidity", async () => {
      // ---------
      // Arrange: Confirm that the wToken balance of the AaveDIVAWrapper contract before removing liquidity is zero.
      // ---------
      const wTokenBalanceAaveDIVAWrapperBefore = await wTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(wTokenBalanceAaveDIVAWrapperBefore).to.eq(0);

      // ---------
      // Act: Remove liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .removeLiquidity(r.poolId, r.positionTokenAmount, r.recipient);

      // ---------
      // Assert: Confirm that AaveDIVAWrapper contract's wToken balance remains zero after removing liquidity.
      // ---------
      const wTokenBalanceAaveDIVAWrapperAfter = await wTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(wTokenBalanceAaveDIVAWrapperAfter).to.eq(0);
    });

    it("The AaveDIVAWrapper contract's collateralToken balance should be zero before and after removing liquidity", async () => {
      // ---------
      // Arrange: Confirm that the collateralToken balance of the AaveDIVAWrapper contract before removing liquidity is zero.
      // ---------
      const collateralTokenContract = await ethers.getContractAt(
        "IERC20",
        collateralToken,
      );
      const collateralTokenBalanceAaveDIVAWrapperBefore =
        await collateralTokenContract.balanceOf(s.aaveDIVAWrapper.target);
      expect(collateralTokenBalanceAaveDIVAWrapperBefore).to.eq(0);

      // ---------
      // Act: Remove liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .removeLiquidity(r.poolId, r.positionTokenAmount, r.recipient);

      // ---------
      // Assert: Confirm that AaveDIVAWrapper contract's collateralToken balance remains zero after removing liquidity.
      // ---------
      const collateralTokenBalanceAaveDIVAWrapperAfter =
        await collateralTokenContract.balanceOf(s.aaveDIVAWrapper.target);
      expect(collateralTokenBalanceAaveDIVAWrapperAfter).to.eq(0);
    });

    it("Should reduce the AaveDIVAWrapper contract's aToken balance after removing liquidity", async () => {
      // ---------
      // Arrange: Get the aToken balance of AaveDIVAWrapper contract before removing liquidity.
      // ---------
      const aTokenBalanceAaveDIVAWrapperBefore = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );

      // ---------
      // Act: Remove liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .removeLiquidity(r.poolId, r.positionTokenAmount, r.recipient);

      // ---------
      // Assert: Confirm that the aToken balance of AaveDIVAWrapper contract reduced by the position token amount removed adjusted for DIVA fee.
      // ---------
      const aTokenBalanceAaveDIVAWrapperAfter = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(aTokenBalanceAaveDIVAWrapperAfter).to.closeTo(
        aTokenBalanceAaveDIVAWrapperBefore -
          BigInt(r.positionTokenAmount) +
          divaFees,
        1,
      ); // closeTo to account for yield that might have accrued since last block
      // @todo could it be a problem where say DIVA owner would be able to fully claim their fees? I don't think so, but maybe due to rounding?
    });

    it("Should not change the accrued yield", async () => {
      // ---------
      // Arrange: Get the accrued yield before adding liquidity.
      // ---------
      const accruedYieldBefore =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);

      // ---------
      // Act: Remove liquidity.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .removeLiquidity(r.poolId, r.positionTokenAmount, r.recipient);

      // ---------
      // Assert: Confirm that the accrued yield remains the same after removing liquidity.
      // ---------
      const accruedYieldAfter =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYieldAfter).to.closeTo(accruedYieldBefore, 1); // closeTo to account for yield that might have accrued since last block
    });

    it("Should return the `_amountReturned` variable", async () => {
      // ---------
      // Arrange: Calculate expected return value.
      // ---------
      const expectedReturnValue = BigInt(r.positionTokenAmount) - divaFees;

      // ---------
      // Act: Remove liquidity.
      // ---------
      const returnedAmount = await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .removeLiquidity.staticCall(
          r.poolId,
          r.positionTokenAmount,
          r.recipient,
        );

      // ---------
      // Assert: Confirm that the returned amount is correct.
      // ---------
      expect(returnedAmount).to.eq(expectedReturnValue);
    });

    it("Should revert if removing liquidity with an invalid poolId", async () => {
      // ---------
      // Arrange: Create a pool on DIVA Protocol with an invalid collateral token.
      // ---------
      // Confirm that the token to be used as collateral for creating the pool in DIVA is not a wToken and hence has not associated collateral token
      // stored in AaveDIVAWrapper.
      const collateralTokenFromWToken =
        await s.aaveDIVAWrapper.getCollateralToken(
          s.createContingentPoolParams.collateralToken,
        );
      expect(collateralTokenFromWToken).to.eq(ethers.ZeroAddress);

      // Update the expiry time to be 1 hour in the future in case the latest block timestamp is greater than the expiryTime
      // defined in `createContingentPoolParams`.
      const lastBlockTimestamp = await getLastTimestamp();
      s.createContingentPoolParams.expiryTime = (
        lastBlockTimestamp + 3600
      ).toString();

      // Create a new contingent pool via DIVA Protocol directly.
      await s.diva
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // Get poolId of the newly created pool.
      const poolId = await getPoolIdFromDIVAEvent(s.diva);

      // ---------
      // Act & Assert: Attempt to remove liquidity with an invalid poolId.
      // ---------
      await expect(
        s.aaveDIVAWrapper.removeLiquidity(
          poolId,
          1,
          s.impersonatedSigner.address,
        ),
      ).to.be.revertedWithCustomError(
        s.aaveDIVAWrapper,
        "CollateralTokenNotRegistered",
      );
    });
  });

  describe("redeemWToken", async () => {
    let s: SetupOutput;
    let wTokenAddress: string;
    let wTokenContract: WToken;
    let poolId: string;
    let poolParams: IDIVA.PoolStructOutput;
    let r: RemoveLiquidityParams;
    let longTokenContract: ERC20;
    let shortTokenContract: ERC20;

    beforeEach(async () => {
      ({
        s,
        wTokenContract,
        wTokenAddress,
        longTokenContract,
        shortTokenContract,
        poolId,
        poolParams,
        r,
      } = await setupWithPool());
    });

    it("Should allocate the DIVA fee denominated in wToken to the DIVA Protocol owner and allow to redeem the wToken for collateral token", async () => {
      // ---------
      // Arrange: Simulate DIVA fee claim resulting in the DIVA treasury having to claim the wToken directly from the DIVA
      // Protocol contract and convert it into collateral token via the `redeemWToken` function.
      // ---------
      // Impersonate the DIVA Protocol treasury account, the account that is eligible to claim the fees inside DIVA Protocol.
      const divaTreasuryInfo = await s.diva.getTreasuryInfo();
      const treasuryAddress = divaTreasuryInfo.treasury;
      await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [treasuryAddress],
      });
      const impersonatedDIVATreasurySigner =
        await ethers.getSigner(treasuryAddress);

      // Get the initial wToken and collateral token balances of the impersonatedDIVATreasurySigner.
      const wTokenBalanceBefore = await wTokenContract.balanceOf(
        impersonatedDIVATreasurySigner.address,
      );
      const collateralTokenBalanceBefore =
        await s.collateralTokenContract.balanceOf(
          impersonatedDIVATreasurySigner.address,
        );

      // Remove liquidity which allocates fees to the treasury account, claimable post pool expiry.
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .removeLiquidity(r.poolId, r.positionTokenAmount, r.recipient);

      // Fast forward in time past pool expiration and report outcome with data provider.
      // It's not relevant which value is reported here. Also, to simplify the test case the
      // challenge functionality has been disabled, so that the value submission is immediately considered final/confirmed.
      const nextBlockTimestamp = Number(poolParams.expiryTime) + 1;
      await mine(nextBlockTimestamp);
      await s.diva
        .connect(s.dataProvider)
        .setFinalReferenceValue(poolId, "1", false);

      // Get updated pool parameters and confirm that the pool was confirmed (equivalent to statusFinalReferenceValue = 3).
      const poolParamsAfter = await s.diva.getPoolParameters(poolId);
      expect(poolParamsAfter.statusFinalReferenceValue).to.eq(3);

      const claimAmount = await s.diva.getClaim(
        wTokenAddress,
        impersonatedDIVATreasurySigner.address,
      );
      expect(claimAmount).to.gt(0);

      // Fund the impersonatedDIVATreasurySigner with MATIC for gas.
      await hre.network.provider.send("hardhat_setBalance", [
        treasuryAddress,
        toBeHex(parseUnits("10", 18)), // Sending 10 MATIC
      ]);

      // Claim DIVA fees with treasury account and send fees to treasury account.
      await s.diva.connect(impersonatedDIVATreasurySigner).claimFee(
        wTokenAddress,
        impersonatedDIVATreasurySigner.address, // fee recipient
      );

      const wTokenBalanceAfter = await wTokenContract.balanceOf(
        impersonatedDIVATreasurySigner.address,
      );
      expect(wTokenBalanceAfter).to.eq(wTokenBalanceBefore + claimAmount);

      // ---------
      // Act: Redeem wToken for collateralToken.
      // ---------
      await s.aaveDIVAWrapper
        .connect(impersonatedDIVATreasurySigner)
        .redeemWToken(
          wTokenAddress,
          wTokenBalanceAfter,
          impersonatedDIVATreasurySigner.address,
        );

      // ---------
      // Assert: Confirm that the collateralToken balance of the impersonatedDIVATreasurySigner increased by the wToken balance after.
      // ---------
      const collateralTokenBalanceAfter =
        await s.collateralTokenContract.balanceOf(
          impersonatedDIVATreasurySigner.address,
        );
      expect(collateralTokenBalanceAfter).to.eq(
        collateralTokenBalanceBefore + wTokenBalanceAfter,
      );
    });

    it("Should return the `_amountReturned` variable", async () => {
      // ---------
      // Arrange: Obtain wToken by removing liquidity from DIVA Protocol directly.
      // ---------
      // Determine the amount to remove by taking the minimum of the user's long and short token balance.
      const longTokenBalance = await longTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      const shortTokenBalance = await shortTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      expect(longTokenBalance + shortTokenBalance).to.gt(0);

      const posBalanceToRedeem =
        longTokenBalance < shortTokenBalance
          ? longTokenBalance
          : shortTokenBalance;
      expect(posBalanceToRedeem).to.gt(0);

      // Remove liquidity from DIVA Protocol to obtain wToken.
      await s.diva
        .connect(s.impersonatedSigner)
        .removeLiquidity(poolId, posBalanceToRedeem);

      // Confirm that the user has a positive wToken balance.
      const wTokenBalance = await wTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      expect(wTokenBalance).to.gt(0);

      // ---------
      // Act: Redeem wToken.
      // ---------
      const returnedAmount = await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemWToken.staticCall(
          wTokenAddress,
          wTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that the returned amount is correct.
      // ---------
      expect(returnedAmount).to.eq(wTokenBalance);
    });
    // @todo Add revert test if user has insufficient wToken balance

    // -------------------------------------------
    // Reverts
    // -------------------------------------------

    it("Should revert if user does not have enough wTokens", async () => {
      // ---------
      // Arrange: Obtain wToken by removing liquidity from DIVA Protocol directly.
      // ---------
      // Determine the amount to remove by taking the minimum of the user's long and short token balance.
      const longTokenBalance = await longTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      const shortTokenBalance = await shortTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      expect(longTokenBalance + shortTokenBalance).to.gt(0);

      const posBalanceToRedeem =
        longTokenBalance < shortTokenBalance
          ? longTokenBalance
          : shortTokenBalance;
      expect(posBalanceToRedeem).to.gt(0);

      // Remove liquidity from DIVA Protocol to obtain wToken.
      await s.diva
        .connect(s.impersonatedSigner)
        .removeLiquidity(poolId, posBalanceToRedeem);

      // Confirm that the user has a positive wToken balance.
      const wTokenBalance = await wTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      expect(wTokenBalance).to.gt(0);

      const wTokenAmountToRedeem = wTokenBalance + BigInt(1);

      // ---------
      // Act & Assert: Attempt to redeem more wTokens than the user has. Should throw in the ERC20's burn function.
      // ---------
      await expect(
        s.aaveDIVAWrapper
          .connect(s.impersonatedSigner)
          .redeemWToken(
            wTokenAddress,
            wTokenAmountToRedeem,
            s.impersonatedSigner.address,
          ),
      )
        .to.be.revertedWithCustomError(
          wTokenContract,
          "ERC20InsufficientBalance",
        )
        .withArgs(
          s.impersonatedSigner.address,
          wTokenBalance,
          wTokenAmountToRedeem,
        );
    });

    it("Should revert if user submits type(uint256).max as wToken amount", async () => {
      // ---------
      // Arrange: Obtain wToken by removing liquidity from DIVA Protocol directly.
      // ---------
      // Determine the amount to remove by taking the minimum of the user's long and short token balance.
      const longTokenBalance = await longTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      const shortTokenBalance = await shortTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      expect(longTokenBalance + shortTokenBalance).to.gt(0);

      const posBalanceToRedeem =
        longTokenBalance < shortTokenBalance
          ? longTokenBalance
          : shortTokenBalance;
      expect(posBalanceToRedeem).to.gt(0);

      // Remove liquidity from DIVA Protocol to obtain wToken.
      await s.diva
        .connect(s.impersonatedSigner)
        .removeLiquidity(poolId, posBalanceToRedeem);

      // Confirm that the user has a positive wToken balance.
      const wTokenBalance = await wTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      expect(wTokenBalance).to.gt(0);

      const wTokenAmountToRedeem = ethers.MaxUint256;

      // ---------
      // Act & Assert: Attempt to redeem more wTokens than the user has. Should throw in the ERC20's burn function.
      // ---------
      await expect(
        s.aaveDIVAWrapper
          .connect(s.impersonatedSigner)
          .redeemWToken(
            wTokenAddress,
            wTokenAmountToRedeem,
            s.impersonatedSigner.address,
          ),
      )
        .to.be.revertedWithCustomError(
          wTokenContract,
          "ERC20InsufficientBalance",
        )
        .withArgs(
          s.impersonatedSigner.address,
          wTokenBalance,
          wTokenAmountToRedeem,
        );
    });
  });

  describe("claimYield", async () => {
    let s: SetupOutput;
    let aTokenContract: ERC20;
    let poolId: string;
    let poolParams: IDIVA.PoolStructOutput;
    let shortTokenContract: ERC20;
    let longTokenContract: ERC20;

    beforeEach(async () => {
      ({
        s,
        aTokenContract,
        poolId,
        poolParams,
        shortTokenContract,
        longTokenContract,
      } = await setupWithPool());
    });

    it("Should allow the owner to claim the accrued yield", async () => {
      // ---------
      // Arrange: Get collateral token balances and simulate yield accrual.
      // ---------
      const collateralTokenBalanceOwnerBefore =
        await s.collateralTokenContract.balanceOf(s.owner.address);

      // Mine several blocks to simulate yield accrual.
      await mine(10000);

      // Get accrued yield before claiming.
      const accruedYieldBefore =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYieldBefore).to.be.gt(10); // 10 is an arbitrary number to ensure that some minimum yield accrued; could have used 1 instead.

      // ---------
      // Act: Claim yield.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .claimYield(s.owner.address, collateralToken);

      // ---------
      // Assert: Confirm that the owner's collateral token balance increased by the accrued yield.
      // ---------
      // Confirm that the accrued yield was reset to zero. // @todo make this a separate test?
      const accruedYieldAfter =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYieldAfter).to.be.lte(1); // Not using eq(0) here because there may have been some yield accrued after the claim.

      // Confirm that the owner's collateral token balance increased by the accrued yield.
      const collateralTokenBalanceOwnerAfter =
        await s.collateralTokenContract.balanceOf(s.owner.address);
      expect(collateralTokenBalanceOwnerAfter).to.be.closeTo(
        collateralTokenBalanceOwnerBefore + accruedYieldBefore,
        1, // closeTo to account for yield that might have accrued since last block
      );
    });

    it("Should decrease the aToken balance of the AaveDIVAWrapper contract", async () => {
      // ---------
      // Arrange: Simulate yield accrual and get aToken balance of AaveDIVAWrapper contract.
      // ---------
      // Mine several blocks to simulate yield accrual.
      await mine(10000);

      // Get the aToken balance of the AaveDIVAWrapper contract before claiming.
      const aTokenBalanceAaveDIVAWrapperBefore = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );

      // Get accrued yield.
      const accruedYield =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);

      // ---------
      // Act: Claim yield.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .claimYield(s.owner.address, collateralToken);

      // ---------
      // Assert: Confirm that the aToken balance of the AaveDIVAWrapper contract decreased by the accrued yield.
      // ---------
      const aTokenBalanceAaveDIVAWrapperAfter = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(aTokenBalanceAaveDIVAWrapperAfter).to.closeTo(
        aTokenBalanceAaveDIVAWrapperBefore - accruedYield,
        1,
      ); // closeTo to account for yield that might have accrued since last block
    });

    it("Should leave the aToken balance of the owner unchanged", async () => {
      // This test is to make sure that the collateral token is returned and not the aToken.

      // ---------
      // Arrange: Get owner's aToken balance and simulate yield accrual.
      // ---------
      const aTokenBalanceOwnerBefore = await aTokenContract.balanceOf(
        s.owner.address,
      );

      // Mine several blocks to simulate yield accrual.
      await mine(10000);

      // ---------
      // Act: Claim yield.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .claimYield(s.owner.address, collateralToken);

      // ---------
      // Assert: Confirm that the aToken balance of the owner remains unchanged.
      // ---------
      const aTokenBalanceOwnerAfter = await aTokenContract.balanceOf(
        s.owner.address,
      );
      expect(aTokenBalanceOwnerAfter).to.be.eq(aTokenBalanceOwnerBefore);
    });

    it("Should send the yield to a non-owner recipient if specified", async () => {
      // ---------
      // Arrange: Get collateral token balance of non-owner account and simulate yield accrual.
      // ---------
      const nonOwnerAccount = s.acc2;
      const collateralTokenBalanceNonOwnerBefore =
        await s.collateralTokenContract.balanceOf(nonOwnerAccount.address);

      // Mine several blocks to simulate yield accrual.
      await mine(10000);

      // Get accrued yield before claiming.
      const accruedYield =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);

      // ---------
      // Act: Claim yield.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .claimYield(nonOwnerAccount.address, collateralToken);

      // ---------
      // Assert: Confirm that the non-owner's collateral token balance increased by the accrued yield.
      // ---------
      const collateralTokenBalanceNonOwnerAfter =
        await s.collateralTokenContract.balanceOf(nonOwnerAccount.address);
      expect(collateralTokenBalanceNonOwnerAfter).to.be.gte(
        collateralTokenBalanceNonOwnerBefore + accruedYield,
      ); // Using >= instead of > here as there could be already accrued yield in the next block after the claim.
    });

    it("Should allow the owner to claim the accrued yield twice", async () => {
      // ---------
      // Arrange: Get owner's collateral token balance, simulate yield accrual, claim once and then simulate yield again for second claim.
      // ---------
      const collateralTokenBalanceOwnerBefore =
        await s.collateralTokenContract.balanceOf(s.owner.address);

      // Mine several blocks to simulate yield accrual.
      await mine(10000);

      // Get accrued yield before first claim.
      const accruedYield1 =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYield1).to.be.gt(10); // 10 is an arbitrary number to ensure that some minimum yield accrued; could have used 1 instead.

      // Claim yield first time.
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .claimYield(s.owner.address, collateralToken);

      // Mine several blocks to simulate yield accrual.
      await mine(20000);

      // Get accrued yield before second claim.
      const accruedYield2 =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYield2).to.be.gt(10); // 10 is an arbitrary number to ensure that some minimum yield accrued; could have used 1 instead.

      // ---------
      // Act: Claim yield second time.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .claimYield(s.owner.address, collateralToken);

      // ---------
      // Assert: Confirm that yield was reset to zero and confirm the owner's collateral token balance increased by the accrued yield.
      // ---------
      expect(
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken),
      ).to.be.lte(1); // Using <= 1 instead of = 0 because there may have been some yield accrued after the second claim.

      const collateralTokenBalanceOwnerAfter =
        await s.collateralTokenContract.balanceOf(s.owner.address);
      expect(collateralTokenBalanceOwnerAfter).to.be.closeTo(
        collateralTokenBalanceOwnerBefore + accruedYield1 + accruedYield2,
        1,
      ); // closeTo to account for yield that might have accrued since last block
    });

    // -------------------------------------------
    // Reverts
    // -------------------------------------------

    it("Should revert if claimable amount is zero", async () => {
      // ---------
      // Arrange: Confirm that no yield has accrued yet. @todo update this part
      // ---------
      // Approve position tokens for AaveDIVAWrapper contract.
      await shortTokenContract
        .connect(s.impersonatedSigner)
        .approve(s.aaveDIVAWrapper.target, ethers.MaxUint256);
      await longTokenContract
        .connect(s.impersonatedSigner)
        .approve(s.aaveDIVAWrapper.target, ethers.MaxUint256);

      // Confirm that the impersonated signer owns all position tokens.
      const amountToRemove = poolParams.collateralBalance;
      const shortTokenBalance = await shortTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      const longTokenBalance = await longTokenContract.balanceOf(
        s.impersonatedSigner.address,
      );
      expect(shortTokenBalance).to.be.eq(amountToRemove);
      expect(longTokenBalance).to.be.eq(amountToRemove);

      // Remove all liquidity to ensure no yield can accrue.
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .removeLiquidity(poolId, amountToRemove, s.owner.address);
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .claimYield(s.owner.address, collateralToken);

      // Claim yield to render accrued yield zero.
      const accruedYield =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYield).to.be.eq(0);

      // ---------
      // Assert & Act: Confirm that the claim transaction fails with Aave's error code 26 (invalid amount)
      // For details, see here: https://github.com/aave/aave-v3-core/blob/b74526a7bc67a3a117a1963fc871b3eb8cea8435/contracts/protocol/libraries/helpers/Errors.sol#L35
      // ---------
      await expect(
        s.aaveDIVAWrapper
          .connect(s.owner)
          .claimYield(s.owner.address, collateralToken),
      ).to.be.revertedWith("26");
    });

    it("Should revert if recipient is zero address", async () => {
      // ---------
      // Arrange: Set recipient to zero address and mine several blocks to simulate non-zero yield to avoid failure due to zero amount (see test above).
      // ---------
      const invalidRecipient = ethers.ZeroAddress;
      await mine(10000);

      // ---------
      // Assert & Act: Attempt to claim yield with zero recipient should fail inside the ERC20 collateral token.
      // ---------
      await expect(
        s.aaveDIVAWrapper
          .connect(s.owner)
          .claimYield(invalidRecipient, collateralToken),
      ).to.be.revertedWith("ERC20: transfer to the zero address");
    });

    it("Should revert if called by non-owner account", async () => {
      // ---------
      // Arrange: Mine several blocks to simulate non-zero yield (otherwise Aave's function which is called inside claimYield will fail with error code 26, invalid amount).
      // ---------
      await mine(10000);

      // ---------
      // Assert & Act: Attempt to claim yield with non-owner account.
      // ---------
      await expect(
        s.aaveDIVAWrapper
          .connect(s.acc2)
          .claimYield(s.acc2.address, collateralToken),
      )
        .to.be.revertedWithCustomError(
          s.aaveDIVAWrapper,
          "OwnableUnauthorizedAccount",
        )
        .withArgs(s.acc2.address);
    });

    // -------------------------------------------
    // Events
    // -------------------------------------------

    it("Should emit YieldClaimed event when owner claims the yield", async () => {
      // ---------
      // Arrange: Mine several blocks to simulate non-zero yield (otherwise Aave's function which is called inside claimYield will fail with error code 26, invalid amount).
      // ---------
      await mine(10000);
      const accruedYield =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);

      // ------
      // Act: Claim yield.
      // ------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .claimYield(s.owner.address, collateralToken);

      // ---------
      // Assert: Confirm that the YieldClaimed event is emitted (using hardhat-chai-matchers library).
      // ---------
      // In ethers v6, events are handled differently than in v5. See here: https://ethereum.stackexchange.com/questions/152626/ethers-6-transaction-receipt-events-information
      const filter = s.aaveDIVAWrapper.filters.YieldClaimed;
      const events = await s.aaveDIVAWrapper.queryFilter(filter);
      const emitRes = events[0].args;

      expect(emitRes[0]).to.eq(s.owner.address); // claimer
      expect(emitRes[1]).to.eq(s.owner.address); // recipient
      expect(emitRes[2]).to.eq(collateralToken); // collateral token address
      expect(emitRes[3]).to.closeTo(accruedYield, 1); // accrued yield amount

      // Note: Not using below way to test the event because I need the closeTo matcher for the accruedYield.
      //   await expect(
      //     s.aaveDIVAWrapper
      //       .connect(s.owner)
      //       .claimYield(s.owner.address, collateralToken),
      //   )
      //     .to.emit(s.aaveDIVAWrapper, "YieldClaimed")
      //     .withArgs(
      //       s.owner.address,
      //       s.owner.address,
      //       collateralToken,
      //       accruedYield,
      //     );
    });
  });

  describe("approveCollateralTokenForAave", async () => {
    let s: SetupOutput;

    beforeEach(async () => {
      // Fetch the setup fixture.
      s = await loadFixture(setup);
    });

    it("Should reset the allowance of the collateral token for Aave V3 to max uint256", async () => {
      // ---------
      // Arrange: Register the collateral token and set some allowance, then reset it.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .registerCollateralToken(collateralToken);
      const collateralTokenContract = await ethers.getContractAt(
        "IERC20",
        collateralToken,
      );
      // Check allowance after registering the collateral token.
      const collateralTokenAllowanceAfterRegister =
        await collateralTokenContract.allowance(
          s.aaveDIVAWrapper.target,
          aaveAddress,
        );
      expect(collateralTokenAllowanceAfterRegister).to.eq(ethers.MaxUint256);

      // Create a contingent pool to reduce the allowance.
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // Check allowance after creating the pool.
      const collateralTokenAllowanceBefore =
        await collateralTokenContract.allowance(
          s.aaveDIVAWrapper.target,
          aaveAddress,
        );
      expect(collateralTokenAllowanceBefore).to.be.lt(ethers.MaxUint256);

      // ---------
      // Act: Reset the allowance to max uint256.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.owner)
        .approveCollateralTokenForAave(collateralToken);

      // ---------
      // Assert: Check that the allowance was reset to max uint256.
      // ---------
      const collateralTokenAllowanceAfter =
        await collateralTokenContract.allowance(
          s.aaveDIVAWrapper.target,
          aaveAddress,
        );
      expect(collateralTokenAllowanceAfter).to.equal(ethers.MaxUint256);
    });

    it("Should allow non-owner accounts to approve collateral token for Aave", async () => {
      // ---------
      // Arrange: Assuming acc2 is a non-owner account.
      // ---------
      const nonOwner = s.acc2;

      await s.aaveDIVAWrapper
        .connect(s.owner)
        .registerCollateralToken(collateralToken);
      const collateralTokenContract = await ethers.getContractAt(
        "IERC20",
        collateralToken,
      );

      // ---------
      // Act: Non-owner attempts to reset the allowance.
      // ---------
      await s.aaveDIVAWrapper
        .connect(nonOwner)
        .approveCollateralTokenForAave(collateralToken);

      // ---------
      // Assert: Check that the allowance was reset to max uint256.
      // ---------
      const collateralTokenAllowance = await collateralTokenContract.allowance(
        s.aaveDIVAWrapper.target,
        aaveAddress,
      );
      expect(collateralTokenAllowance).to.equal(ethers.MaxUint256);
    });

    // -------------------------------------------
    // Reverts
    // -------------------------------------------

    it("Should revert if trying to approve an unregistered collateral token for Aave", async () => {
      // ---------
      // Arrange: Use an unregistered collateral token address.
      // ---------
      const unregisteredCollateralToken =
        "0x000000000000000000000000000000000000dead";

      // ---------
      // Act & Assert: Expect to revert with the error 'CollateralTokenNotRegistered'.
      // ---------
      await expect(
        s.aaveDIVAWrapper
          .connect(s.owner)
          .approveCollateralTokenForAave(unregisteredCollateralToken),
      ).to.be.revertedWithCustomError(
        s.aaveDIVAWrapper,
        "CollateralTokenNotRegistered",
      );
    });
  });

  describe("redeemPositionToken", async () => {
    let s: SetupOutput;
    let wTokenContract: WToken;
    let aTokenContract: ERC20;
    let shortTokenContract: ERC20; // @todo replace by PositionTokenContract interface?
    let longTokenContract: ERC20; // @todo replace by PositionTokenContract interface?
    let poolId: string;
    let poolParams: IDIVA.PoolStructOutput;
    let divaFees: bigint;
    let collateralTokenBalance: bigint;
    let longTokenBalance: bigint;
    let shortTokenBalance: bigint;
    let wTokenSupply: bigint;
    let expectedLongTokenPayout: bigint;
    let expectedShortTokenPayout: bigint;

    beforeEach(async () => {
      ({
        s,
        poolId,
        poolParams,
        longTokenContract,
        shortTokenContract,
        longTokenBalance,
        shortTokenBalance,
        collateralTokenBalance,
        wTokenSupply,
        wTokenContract,
        aTokenContract,
        divaFees,
        expectedLongTokenPayout,
        expectedShortTokenPayout,
      } = await setupWithConfirmedPool());
    });

    it("Should reduce the long token balance of the redeeming user", async () => {
      // ---------
      // Arrange: `longTokenBalance` of impersonatedSigner is retrieved inside `setupWithConfirmedPool`.
      // ---------

      // ---------
      // Act: Redeem long position token for collateral token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.longToken,
          longTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that the user's long token balances reduces to zero.
      // ---------
      const longTokenBalanceAfter = await longTokenContract.balanceOf(
        s.impersonatedSigner,
      );
      expect(longTokenBalanceAfter).to.eq(0);
    });

    it("Should reduce the short token balance of the redeeming user", async () => {
      // ---------
      // Arrange: `shortTokenBalance` of impersonatedSigner is retrieved inside `setupWithConfirmedPool`.
      // ---------

      // ---------
      // Act: Redeem short position token for collateral token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.shortToken,
          shortTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that the user's long token balances reduces to zero.
      // ---------
      const shortTokenBalanceAfter = await shortTokenContract.balanceOf(
        s.impersonatedSigner,
      );
      expect(shortTokenBalanceAfter).to.eq(0);
    });

    it("Should increase the user's collateral token balance", async () => {
      // ---------
      // Arrange: Expected long and short token payouts are calculated inside the `setupWithConfirmedPool` function.
      // ---------

      // ---------
      // Act 1: Redeem long position token for collateral token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.longToken,
          longTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert 1: Confirm that the collateralToken balance of the impersonatedSigner increased by the expected long token payout.
      // ---------
      const collateralTokenBalanceAfterLongRedemption =
        await s.collateralTokenContract.balanceOf(s.impersonatedSigner.address);
      expect(collateralTokenBalanceAfterLongRedemption).to.eq(
        collateralTokenBalance + expectedLongTokenPayout,
      );

      // ---------
      // Act 2: Redeem short position token for collateral token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.shortToken,
          shortTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert 2: Confirm that the collateralToken balance of the impersonatedSigner increased by the expected short token payout.
      // ---------
      const collateralTokenBalanceAfterShortRedemption =
        await s.collateralTokenContract.balanceOf(s.impersonatedSigner.address);
      expect(collateralTokenBalanceAfterShortRedemption).to.eq(
        collateralTokenBalanceAfterLongRedemption + expectedShortTokenPayout,
      );
    });

    it("Should reduce the wToken supply after redeeming long tokens", async () => {
      // ---------
      // Arrange: `wTokenSupply` of wTokenContract is retrieved inside `setupWithConfirmedPool`.
      // ---------

      // ---------
      // Act: Redeem long position token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.longToken,
          longTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that the wToken supply reduced by the long token amount redeemed adjusted for DIVA fee.
      // ---------
      const wTokenSupplyAfter = await wTokenContract.totalSupply();
      expect(wTokenSupplyAfter).to.eq(wTokenSupply - expectedLongTokenPayout);
    });

    it("Should reduce the wToken supply after redeeming short tokens", async () => {
      // ---------
      // Arrange: `wTokenSupply` of wTokenContract is retrieved inside `setupWithConfirmedPool`.
      // ---------

      // ---------
      // Act: Redeem short position token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.shortToken,
          shortTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that the wToken supply reduced by the short token amount redeemed adjusted for DIVA fee.
      // ---------
      const wTokenSupplyAfter = await wTokenContract.totalSupply();
      expect(wTokenSupplyAfter).to.eq(
        BigInt(wTokenSupply) - BigInt(expectedShortTokenPayout),
      );
    });

    it("The AaveDIVAWrapper contract's wToken balance should be zero before and after redeeming long tokens", async () => {
      // ---------
      // Arrange: Confirm that the wToken balance of the AaveDIVAWrapper contract before redeeming long tokens is zero.
      // ---------
      const wTokenBalanceAaveDIVAWrapperBefore = await wTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(wTokenBalanceAaveDIVAWrapperBefore).to.eq(0);

      // ---------
      // Act: Redeem long position token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.longToken,
          longTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that AaveDIVAWrapper contract's wToken balance remains zero after redeeming long tokens.
      // ---------
      const wTokenBalanceAaveDIVAWrapperAfter = await wTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(wTokenBalanceAaveDIVAWrapperAfter).to.eq(0);
    });

    it("The AaveDIVAWrapper contract's wToken balance should be zero before and after redeeming short tokens", async () => {
      // ---------
      // Arrange: Confirm that the wToken balance of the AaveDIVAWrapper contract before redeeming short tokens is zero.
      // ---------
      const wTokenBalanceAaveDIVAWrapperBefore = await wTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(wTokenBalanceAaveDIVAWrapperBefore).to.eq(0);

      // ---------
      // Act: Redeem short position token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.shortToken,
          shortTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that AaveDIVAWrapper contract's wToken balance remains zero after redeeming short tokens.
      // ---------
      const wTokenBalanceAaveDIVAWrapperAfter = await wTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(wTokenBalanceAaveDIVAWrapperAfter).to.eq(0);
    });

    it("The AaveDIVAWrapper contract's collateralToken balance should be zero before and after redeeming long tokens", async () => {
      // ---------
      // Arrange: Confirm that the collateralToken balance of the AaveDIVAWrapper contract before redeeming long tokens is zero.
      // ---------
      const collateralTokenContract = await ethers.getContractAt(
        "IERC20",
        collateralToken,
      );
      const collateralTokenBalanceAaveDIVAWrapperBefore =
        await collateralTokenContract.balanceOf(s.aaveDIVAWrapper.target);
      expect(collateralTokenBalanceAaveDIVAWrapperBefore).to.eq(0);

      // ---------
      // Act: Redeem long position token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.longToken,
          longTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that AaveDIVAWrapper contract's collateralToken balance remains zero after redeeming long tokens.
      // ---------
      const collateralTokenBalanceAaveDIVAWrapperAfter =
        await collateralTokenContract.balanceOf(s.aaveDIVAWrapper.target);
      expect(collateralTokenBalanceAaveDIVAWrapperAfter).to.eq(0);
    });

    it("The AaveDIVAWrapper contract's collateralToken balance should be zero before and after redeeming short tokens", async () => {
      // ---------
      // Arrange: Confirm that the collateralToken balance of the AaveDIVAWrapper contract before redeeming short tokens is zero.
      // ---------
      const collateralTokenContract = await ethers.getContractAt(
        "IERC20",
        collateralToken,
      );
      const collateralTokenBalanceAaveDIVAWrapperBefore =
        await collateralTokenContract.balanceOf(s.aaveDIVAWrapper.target);
      expect(collateralTokenBalanceAaveDIVAWrapperBefore).to.eq(0);

      // ---------
      // Act: Redeem short position token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.shortToken,
          shortTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that AaveDIVAWrapper contract's collateralToken balance remains zero after redeeming short tokens.
      // ---------
      const collateralTokenBalanceAaveDIVAWrapperAfter =
        await collateralTokenContract.balanceOf(s.aaveDIVAWrapper.target);
      expect(collateralTokenBalanceAaveDIVAWrapperAfter).to.eq(0);
    });

    it("Should reduce the AaveDIVAWrapper contract's aToken balance after redeeming long tokens", async () => {
      // ---------
      // Arrange: Get the aToken balance of AaveDIVAWrapper contract before redeeming long tokens.
      // ---------
      const aTokenBalanceAaveDIVAWrapperBefore = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );

      // ---------
      // Act: Redeem long position token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.longToken,
          longTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that the aToken balance of AaveDIVAWrapper contract reduced by the payout received by the user.
      // ---------
      const aTokenBalanceAaveDIVAWrapperAfter = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(aTokenBalanceAaveDIVAWrapperAfter).to.closeTo(
        aTokenBalanceAaveDIVAWrapperBefore - expectedLongTokenPayout,
        1,
      ); // closeTo to account for yield that might have accrued since last block
      // @todo could it be a problem where say DIVA owner would be able to fully claim their fees? I don't think so, but maybe due to rounding?
    });

    it("Should reduce the AaveDIVAWrapper contract's aToken balance after redeeming short tokens", async () => {
      // ---------
      // Arrange: Get the aToken balance of AaveDIVAWrapper contract before redeeming short tokens.
      // ---------
      const aTokenBalanceAaveDIVAWrapperBefore = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );

      // ---------
      // Act: Redeem short position token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.shortToken,
          shortTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that the aToken balance of AaveDIVAWrapper contract reduced by the payout received by the user.
      // ---------
      const aTokenBalanceAaveDIVAWrapperAfter = await aTokenContract.balanceOf(
        s.aaveDIVAWrapper.target,
      );
      expect(aTokenBalanceAaveDIVAWrapperAfter).to.closeTo(
        aTokenBalanceAaveDIVAWrapperBefore - expectedShortTokenPayout,
        1,
      ); // closeTo to account for yield that might have accrued since last block
      // @todo could it be a problem where say DIVA owner would be able to fully claim their fees? I don't think so, but maybe due to rounding?
    });

    it("Should not change the accrued yield if long token is redeemed", async () => {
      // ---------
      // Arrange: Get the accrued yield before redeeming long tokens.
      // ---------
      const accruedYieldBefore =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);

      // ---------
      // Act: Redeem long position token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.longToken,
          longTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that the accrued yield remains the same after redeeming long tokens.
      // ---------
      const accruedYieldAfter =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYieldAfter).to.closeTo(accruedYieldBefore, 1); // closeTo to account for yield that might have accrued since last block
    });

    it("Should not change the accrued yield if short token is redeemed", async () => {
      // ---------
      // Arrange: Get the accrued yield before redeeming short tokens.
      // ---------
      const accruedYieldBefore =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);

      // ---------
      // Act: Redeem short position token.
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.shortToken,
          shortTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that the accrued yield remains the same after redeeming short tokens.
      // ---------
      const accruedYieldAfter =
        await s.aaveDIVAWrapper.getAccruedYield(collateralToken);
      expect(accruedYieldAfter).to.closeTo(accruedYieldBefore, 1); // closeTo to account for yield that might have accrued since last block
    });

    it("Should update all balances as expected when both long and short tokens are redeemed", async () => {
      // ---------
      // Arrange: `longTokenBalance`, `shortTokenBalance`, `collateralTokenBalance` and `wTokenSupply` of impersonatedSigner
      // are retrieved inside `setupWithConfirmedPool`.
      // ---------

      // ---------
      // Act: Redeem long and short position tokens .
      // ---------
      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.longToken,
          longTokenBalance,
          s.impersonatedSigner.address,
        );

      await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken(
          poolParams.shortToken,
          shortTokenBalance,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert 1: Confirm that the user's long and short token balances reduced to zero.
      // ---------
      const longTokenBalanceAfter = await longTokenContract.balanceOf(
        s.impersonatedSigner,
      );
      const shortTokenBalanceAfter = await shortTokenContract.balanceOf(
        s.impersonatedSigner,
      );
      expect(longTokenBalanceAfter).to.eq(0);
      expect(shortTokenBalanceAfter).to.eq(0);

      // ---------
      // Assert 2: Confirm that the user's collateral token balance increased by the expected long and short token payouts.
      // ---------
      const collateralTokenBalanceAfter =
        await s.collateralTokenContract.balanceOf(s.impersonatedSigner.address);
      expect(collateralTokenBalanceAfter).to.eq(
        collateralTokenBalance +
          expectedLongTokenPayout +
          expectedShortTokenPayout,
      );

      // ---------
      // Assert 3: Confirm that the wToken supply reduced by the redeemed amount.
      // ---------
      const wTokenSupplyAfter = await wTokenContract.totalSupply();
      expect(wTokenSupplyAfter).to.eq(
        wTokenSupply - expectedLongTokenPayout - expectedShortTokenPayout,
      );
    });

    it("Should return the `_amountReturned` variable", async () => {
      // ---------
      // Arrange: Define the position token and amount to redeem (should be positive).
      // ---------
      expect(longTokenBalance + shortTokenBalance).to.gt(0);
      let posTokenToRedeem: string;
      let posBalanceToRedeem: bigint;
      if (longTokenBalance > 0) {
        posTokenToRedeem = poolParams.longToken;
        posBalanceToRedeem = longTokenBalance;
      } else {
        posTokenToRedeem = poolParams.shortToken;
        posBalanceToRedeem = shortTokenBalance;
      }

      // ---------
      // Act: Redeem the position token.
      // ---------
      const returnedAmount = await s.aaveDIVAWrapper
        .connect(s.impersonatedSigner)
        .redeemPositionToken.staticCall(
          posTokenToRedeem,
          posBalanceToRedeem,
          s.impersonatedSigner.address,
        );

      // ---------
      // Assert: Confirm that the returned amount is correct.
      // ---------
      if (longTokenBalance > 0) {
        expect(returnedAmount).to.eq(expectedLongTokenPayout);
      } else {
        expect(returnedAmount).to.eq(expectedShortTokenPayout);
      }
    });

    it("Should revert if redeeming with an invalid position token", async () => {
      // ---------
      // Arrange: Create a pool on DIVA Protocol with an invalid collateral token.
      // ---------
      // Confirm that the token to be used as collateral for creating the pool in DIVA is not a wToken and hence has not associated collateral token
      // stored in AaveDIVAWrapper.
      const collateralTokenFromWToken =
        await s.aaveDIVAWrapper.getCollateralToken(
          s.createContingentPoolParams.collateralToken,
        );
      expect(collateralTokenFromWToken).to.eq(ethers.ZeroAddress);

      // Update the expiry time to be 1 hour in the future in case the latest block timestamp is greater than the expiryTime
      // defined in `createContingentPoolParams`.
      const lastBlockTimestamp = await getLastTimestamp();
      s.createContingentPoolParams.expiryTime = (
        lastBlockTimestamp + 3600
      ).toString();

      // Create a new contingent pool via DIVA Protocol directly.
      await s.diva
        .connect(s.impersonatedSigner)
        .createContingentPool(s.createContingentPoolParams);

      // Get pool parameters for the newly created pool.
      const poolId = await getPoolIdFromDIVAEvent(s.diva);
      const poolParams = await s.diva.getPoolParameters(poolId);

      // ---------
      // Act & Assert: Attempt to redeem with an invalid position token.
      // ---------
      await expect(
        s.aaveDIVAWrapper.redeemPositionToken(
          poolParams.shortToken,
          1,
          s.impersonatedSigner.address,
        ),
      ).to.be.revertedWithCustomError(
        s.aaveDIVAWrapper,
        "CollateralTokenNotRegistered",
      );
    });

    // @todo Add test if collateralTokenAmount is zero, then it should revert with INVALID_AMOUNT in Aave

    // @todo confirm that the long and short token balances of AaveDIVAWrapper did not change after pool creation
    // @todo check return value of redeemPositionToken

    // @todo use different payoff profiles where both short and long are positive payoff
  });
});

// @todo Test case: Check contract deployment with an invalid collateral token -> aTokenAddress should be zero and it should throw
