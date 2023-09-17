import Container, { Service } from "typedi";
import {
  AuthHashProvider,
  AuthTokenProvider,
  BaseService,
  Context,
  MailProvider,
  MailTemplateType,
  env,
} from "../core";
import {
  CustomerProfile,
  User,
  UserRole,
  SellerProfile,
  TokenObject,
} from "../models";
import { UserInfo } from "../models";
import { UserRepository } from "../repositories";
import { LoginRequest } from "../controllers/request/auth.request";
import { Action } from "routing-controllers";

@Service()
export class AuthService extends BaseService {
  constructor(
    private _userRepository: UserRepository,
    private _hashService: AuthHashProvider,
    private _tokenService: AuthTokenProvider,
    private _mailService: MailProvider
  ) {
    super(__filename);
    if (!this._hashService) this._hashService = Container.get(AuthHashProvider);
    if (!this._tokenService)
      this._tokenService = Container.get(AuthTokenProvider);
    if (!this._mailService) this._mailService = Container.get(MailProvider);
  }

  async signUpUser(user: User): Promise<AuthInfo> {
    user.email = user.email.toLowerCase();
    this._logger.info(`Attempting to sign up user with email ${user.email}`);

    this._logger.info(`Verifying user's email ${user.email}`);
    const alreadySignedUp = await this._userRepository.getUserByEmail(
      user.email,
      false
    );

    if (alreadySignedUp) throw new Error("User already exists");

    this._logger.info(`Hashing user's password`);
    user.password = await this._hashService.hashPassword(user.password);

    const createdUser = await this._userRepository.createUser(user);

    // #region Send Email Verification Email
    const { _id, email, role } = createdUser;
    const id = (_id as string).toString();
    const name =
      user.role === UserRole.SELLER
        ? (user.profile as SellerProfile).name
        : (user.profile as CustomerProfile).firstName;

    const requestId = Context.getRequestId();

    const emailVerificationToken =
      this._tokenService.generateToken<AuthPayload>(
        {
          requestId,
          identityId: id,
          email,
        },
        { expiresIn: env.auth.emailVerificationTokenExpiresIn }
      );

    this._logger.info(`Sending email verification email to ${email}`);

    await this._mailService.sendMail(
      {
        name,
        email,
      },
      "Verify your Email",
      this._mailService.parseMailTemplate(MailTemplateType.EMAIL_VERIFICATION, {
        USER_NAME: name,
        CALL_TO_ACTION_URL: `${env.frontend.emailVerificationUrl}?token=${emailVerificationToken}`,
      })
    );
    // #endregion

    const tokens = this.getTokens({
      requestId,
      identityId: id,
      email: email,
      signedAt: +new Date(),
    });

    return {
      userInfo: {
        id,
        email,
        role,
      },
      tokens,
    };
  }

  async signOutUser(tokens: Tokens): Promise<void> {
    this._logger.info(`Attempting to sign out user by blocking their tokens`);

    let identityId: string,
      emailAddress: string,
      accessTokenExpiry: number,
      refreshTokenExpiry: number;

    // #region Verify Access and Refresh Tokens
    try {
      const {
        identityId: id,
        email,
        exp,
      } = this._tokenService.verifyToken<AuthPayload & { exp: number }>(
        tokens.accessToken
      );

      if (!id || !email) throw new Error("malformed token");

      identityId = id;
      emailAddress = email;
      accessTokenExpiry = exp;
    } catch (error: any) {
      throw new Error(`Failed to verify access token, ${error.message}`);
    }

    try {
      const { exp } = this._tokenService.verifyToken<
        AuthPayload & { exp: number }
      >(tokens.refreshToken);

      refreshTokenExpiry = exp;
    } catch (error: any) {
      throw new Error(`Failed to verify refresh token, ${error.message}`);
    }
    // #endregion

    const user = await this._userRepository.getUserByEmail(emailAddress);

    this._logger.info(
      "Adding access and refresh tokens to the user's blocklist"
    );

    const tokensBlocklist = [
      ...user.tokensBlocklist,
      { token: tokens.accessToken, expiresIn: accessTokenExpiry },
      { token: tokens.refreshToken, expiresIn: refreshTokenExpiry },
    ];

    await this._userRepository.updateUser({
      _id: identityId,
      tokensBlocklist,
    } as User);
  }

  async authenticateUser({ email, password }: LoginRequest): Promise<AuthInfo> {
    email = email.toLowerCase();
    this._logger.info(`Attempting to authenticate user with email ${email}`);

    this._logger.info(`Verifying user's email ${email}`);
    const user = await this._userRepository.getUserByEmail(email);

    // #region Clear Expired Tokens
    this._logger.info("Clearing user's expired tokens from blocklist");

    // Calculate the current timestamp in seconds (Unix timestamp)
    const currentTimestampInSeconds = Math.floor(Date.now() / 1000); // Convert milliseconds to seconds

    // Filter tokens that have not yet expired
    const updatedTokensBlocklist = user.tokensBlocklist.filter(
      (token) => token.expiresIn > currentTimestampInSeconds
    );

    await this._userRepository.updateUser({
      _id: user._id,
      tokensBlocklist: updatedTokensBlocklist,
    } as User);
    //#endregion

    this._logger.info(`Verifying user's password`);
    const passwordMatch = await this._hashService.verifyPassword(
      password,
      user.password
    );

    if (!passwordMatch) throw new Error("Invalid password");

    const id = (user._id as string).toString();

    const tokens = this.getTokens({
      requestId: Context.getRequestId(),
      identityId: id,
      email: user.email,
      signedAt: +new Date(),
    });

    return {
      userInfo: {
        id,
        email,
        role: user.role,
      },
      tokens,
    };
  }

  async authorizeUser(
    action: Action,
    rolesAndPermission: RolesAndPermission[]
  ): Promise<void> {
    let user: User,
      token = action.request.headers["authorization"];
    token = token.split("Bearer ").length > 1 ? token.split(" ")[1] : token;

    this._logger.info(`Attempting to authorize user with token ${token}`);

    // #region Verify Authorization Token
    this._logger.info("Verifying authorization token");

    if (!token) throw new Error("Unauthorized, missing authorization token");

    let payload: AuthPayload;

    try {
      payload = this._tokenService.verifyToken<AuthPayload>(token);
    } catch (error: any) {
      throw new Error(`Failed to verify authorization token, ${error.message}`);
    }

    user = await this._userRepository.getUserByEmail(payload.email);
    user._id = (user._id as string).toString();

    if (
      (payload.signedAt as number) < user.passwordUpdatedAt ||
      user.tokensBlocklist.find((object) => object.token === token)
    )
      throw new Error("Authorization token is not valid anymore");
    // #endregion

    if (
      !user.verified &&
      action.request.originalUrl.split("logout").length === 1
    )
      throw new Error(`${user.email} is not verified`);

    // #region Verify Role and Permission
    const { roles, disclaimer } = rolesAndPermission[0];

    this._logger.info("Verifying user's role");

    /*** To Do: Implement Permission Verification ***/

    if (!roles.includes(user.role))
      throw new Error(
        disclaimer ?? "Unauthorized, user does not have the required role"
      );
    // #endregion

    // Set user in Context
    this._logger.info("Setting user in Context");
    Context.setUser(user);
  }

  async verifyEmailAddress(token: string): Promise<void> {
    let id: string, email: string;

    try {
      const authPayload = this._tokenService.verifyToken<AuthPayload>(token);
      id = authPayload.identityId;
      email = authPayload.email;
    } catch (error) {
      throw new Error(
        "Failed to verify email address, invalid verification token"
      );
    }

    try {
      const user = await this._userRepository.getUserByEmail(email);
      if (user.verified) throw new Error(`${email} is already verified`);
    } catch (error: any) {
      throw new Error(`Failed to verify email address, ${error.message}`);
    }

    this._logger.info(`Verifying email address for user with email ${email}`);

    await this._userRepository.updateUser({
      _id: id,
      verified: true,
    } as User);
  }

  async sendPasswordResetLink(email: string): Promise<void> {
    email = email.toLowerCase();

    this._logger.info(`Verifying user's email ${email}`);
    const user = await this._userRepository.getUserByEmail(email);

    if (!user.verified) throw new Error(`${email} is not verified`);

    const id = (user._id as string).toString();
    const name =
      user.role === UserRole.SELLER
        ? (user.profile as SellerProfile).name
        : (user.profile as CustomerProfile).firstName;

    const passwordResetToken = this._tokenService.generateToken<AuthPayload>(
      {
        requestId: Context.getRequestId(),
        identityId: id,
        email,
      },
      { expiresIn: env.auth.passwordResetTokenExpiresIn }
    );

    this._logger.info(`Sending password reset email to ${email}`);

    await this._mailService.sendMail(
      {
        name,
        email,
      },
      "Reset your password",
      this._mailService.parseMailTemplate(MailTemplateType.PASSWORD_RESET, {
        USER_NAME: name,
        CALL_TO_ACTION_URL: `${env.frontend.passwordResetUrl}?token=${passwordResetToken}`,
      })
    );
  }

  async resetPassword(token: string, password: string): Promise<void> {
    let id: string,
      email: string,
      tokenExpiry: number,
      tokensBlocklist: TokenObject[];

    // #region Verify Token
    try {
      const authPayload = this._tokenService.verifyToken<
        AuthPayload & { exp: number }
      >(token);

      id = authPayload.identityId;
      email = authPayload.email;
      tokenExpiry = authPayload.exp;
    } catch (error) {
      throw new Error("Failed to reset password, invalid reset token");
    }

    try {
      const user = await this._userRepository.getUserByEmail(email);

      if (!user.verified) throw new Error(`${email} is not verified`);

      tokensBlocklist = user.tokensBlocklist;

      if (tokensBlocklist.find((object) => object.token === token))
        throw new Error(`token is already used`);
    } catch (error: any) {
      throw new Error(`Failed to reset password, ${error.message}`);
    }
    // #endregion

    this._logger.info("Adding password reset token to the user's blocklist");
    const updatedTokensBlocklist = [
      ...tokensBlocklist,
      { token, expiresIn: tokenExpiry },
    ];

    const hashedPassword = await this._hashService.hashPassword(password);

    this._logger.info(`Resetting password for user with email ${email}`);
    await this._userRepository.updateUser({
      _id: id,
      password: hashedPassword,
      passwordUpdatedAt: +new Date(),
      tokensBlocklist: updatedTokensBlocklist,
    } as User);
  }

  async updatePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    const user = Context.getUser();

    const passwordMatch = await this._hashService.verifyPassword(
      currentPassword,
      user.password
    );
    if (!passwordMatch) throw new Error("Current password is incorrect");

    const hashedPassword = await this._hashService.hashPassword(newPassword);

    this._logger.info(`Updating password for user with id ${user._id}`);

    await this._userRepository.updateUser({
      _id: user._id,
      password: hashedPassword,
      passwordUpdatedAt: +new Date(),
    } as User);
  }

  refreshAccessToken(refreshToken: string): Tokens {
    this._logger.info("Verifying refresh token");

    const { identityId, email } =
      this._tokenService.verifyToken<AuthPayload>(refreshToken);

    this._logger.info(
      `Generating new access token for user with email ${email}`
    );

    const accessToken = this._tokenService.generateToken<AuthPayload>(
      { identityId, email } as AuthPayload,
      { expiresIn: env.auth.accessTokenExpiresIn }
    );

    return { accessToken, refreshToken };
  }

  private getTokens(
    { requestId, identityId, email, signedAt }: AuthPayload,
    refreshToken?: string
  ): Tokens {
    const generateToken = (expiry) =>
      this._tokenService.generateToken<AuthPayload>(
        {
          requestId,
          identityId,
          email,
          signedAt,
        },
        {
          // If expiry is not a number, keep it as it is (in string format)
          // Otherwise, transform its data type from string to integer
          expiresIn: isNaN(Number(expiry)) ? expiry : Number(expiry),
        }
      );

    this._logger.info("Generating access token");
    const accessToken = generateToken(env.auth.accessTokenExpiresIn);

    if (!refreshToken) {
      this._logger.info("Generating refresh token");
      refreshToken = generateToken(env.auth.refreshTokenExpiresIn);
    }

    return {
      accessToken,
      refreshToken,
    };
  }
}

export class AuthInfo {
  userInfo: UserInfo;
  tokens: Tokens;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthPayload {
  requestId: string;
  identityId: string;
  email: string;
  signedAt?: number;
}

export interface RolesAndPermission {
  roles: UserRole[];
  permission?: string;
  disclaimer?: string;
}
